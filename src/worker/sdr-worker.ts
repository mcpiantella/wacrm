/**
 * SDR worker — the long-running consumer of the `sdr` queue.
 *
 * Runs as its own process (separate Easypanel service, same image):
 *   npm run worker   →   tsx src/worker/sdr-worker.ts
 *
 * For each job it loads the conversation context, asks the pure core for
 * a decision, and executes it (send + persist / handoff / log). Service-
 * role throughout — there is no user session here. MUST share the web
 * app's ENCRYPTION_KEY so it can decrypt channel credentials.
 */
// MUST be first: installs a global WebSocket (for supabase-js Realtime) on
// Node < 22, before any Supabase client is constructed below.
import './ws-polyfill'
import { Worker } from 'bullmq'
import { getRedisConnection } from '@/lib/queue/connection'
import { SDR_QUEUE_NAME, type SdrJobData, enqueueFollowUp } from '@/lib/queue/sdr-queue'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { chatComplete } from '@/lib/ai/chat'
import { getTranscriber } from '@/lib/ai/transcription/factory'
import { loadSdrContext, decideFromContext } from '@/lib/sdr/core'
import { decideFollowUp } from '@/lib/sdr/followup'
import { consumeAiMessageOrThrow } from '@/lib/billing/quota'
import { BillingError } from '@/lib/billing/errors'
import { recordBillingEvent } from '@/lib/billing/events'
import { getPlanAllowedModels } from '@/lib/billing/allowed-models'
import { executeDecision, executeFollowUp, CHANNEL_COLUMNS, type ExecuteDeps } from '@/lib/sdr/execute'
import { createChannel } from '@/lib/whatsapp/channel/factory'
import type { ChannelRow } from '@/lib/whatsapp/channel/types'
import type { SdrDeps } from '@/lib/sdr/types'

const sdrDeps: SdrDeps = {
  transcribe: (input) => getTranscriber().transcribe(input),
  chat: chatComplete,
}

const execDeps: ExecuteDeps = {
  supabase: supabaseAdmin(),
  sendOnChannel: (channel: ChannelRow, to: string, text: string) =>
    createChannel(channel).sendText({ to, text }),
  // notify: wired once a per-account notification number exists (SDR-8).
}

async function handleJob(conversationId: string): Promise<void> {
  const ctx = await loadSdrContext(supabaseAdmin(), conversationId)
  if (!ctx) {
    console.warn('[sdr-worker] context not found for', conversationId)
    return
  }
  // Cost guard: a stored model must still be in the account's current plan
  // allow-list. If the plan was downgraded (or the row was patched directly),
  // fall back to the default model instead of billing a premium model.
  if (ctx.config?.model) {
    const allowed = await getPlanAllowedModels(supabaseAdmin(), ctx.conversation.account_id)
    if (!allowed.includes(ctx.config.model)) {
      console.warn(`[sdr-worker] model ${ctx.config.model} not allowed for account ${ctx.conversation.account_id}; using default`)
      ctx.config.model = null
    }
  }

  try {
    const decision = await decideFromContext(ctx, sdrDeps)

    // Billing: a reply is a billable AI message — consume quota atomically
    // first. If the account is blocked or out of quota, skip the send.
    if (decision.action === 'reply') {
      try {
        await consumeAiMessageOrThrow(supabaseAdmin(), ctx.conversation.account_id)
      } catch (err) {
        if (err instanceof BillingError) {
          await recordBillingEvent(supabaseAdmin(), ctx.conversation.account_id, 'ai_quota_blocked', {
            code: err.code,
            conversation_id: conversationId,
          })
          await supabaseAdmin().from('sdr_runs').insert({
            account_id: ctx.conversation.account_id,
            conversation_id: ctx.conversation.id,
            broadcast_id: ctx.conversation.broadcast_id,
            inbound_message_ids: [],
            action: 'noop',
            error: `billing: ${err.code}`,
          })
          console.log(`[sdr-worker] ${conversationId} → blocked (${err.code})`)
          return
        }
        throw err
      }
    }

    await executeDecision(execDeps, decision, ctx)
    console.log(`[sdr-worker] ${conversationId} → ${decision.action} (${decision.reason})`)
    // Arm all reminders up front (absolute offsets from this reply). Each
    // has its own jobId, so they don't dedupe against each other and we
    // never reschedule from inside a running follow-up job.
    if (decision.action === 'reply' && ctx.config?.follow_up_enabled) {
      const delays = ctx.config.follow_up_delays ?? []
      for (let i = 0; i < delays.length; i++) {
        await enqueueFollowUp(
          conversationId,
          ctx.conversation.account_id,
          i + 1,
          delays[i],
        ).catch((e) => console.error('[sdr-worker] schedule follow-up failed:', e))
      }
    }
  } catch (err) {
    // The decide phase (LLM / transcription) threw — executeDecision never
    // ran, so nothing was logged. Persist an 'error' run so the failure is
    // visible in the DB (sdr_runs), not just the worker stdout.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[sdr-worker] ${conversationId} decide failed:`, message)
    try {
      await supabaseAdmin()
        .from('sdr_runs')
        .insert({
          account_id: ctx.conversation.account_id,
          conversation_id: ctx.conversation.id,
          broadcast_id: ctx.conversation.broadcast_id,
          inbound_message_ids: [],
          action: 'error',
          error: message,
        })
    } catch (e) {
      console.error('[sdr-worker] error-run insert failed:', e)
    }
  }
}

async function handleFollowUp(
  conversationId: string,
  attempt: number,
): Promise<void> {
  const supabase = supabaseAdmin()
  const ctx = await loadSdrContext(supabase, conversationId)
  if (!ctx) return

  // Cost guard: re-validate stored model against the account's current plan.
  if (ctx.config?.model) {
    const allowed = await getPlanAllowedModels(supabaseAdmin(), ctx.conversation.account_id)
    if (!allowed.includes(ctx.config.model)) {
      console.warn(`[sdr-worker] model ${ctx.config.model} not allowed for account ${ctx.conversation.account_id}; using default`)
      ctx.config.model = null
    }
  }

  let channel = null
  let provider = ''
  if (ctx.conversation.channel_id) {
    const { data } = await supabase
      .from('channels')
      .select(CHANNEL_COLUMNS)
      .eq('id', ctx.conversation.channel_id)
      .maybeSingle()
    channel = data
    provider = (data?.provider as string) ?? ''
  }

  const decision = await decideFollowUp(ctx, attempt, provider, sdrDeps)
  if (decision.action === 'noop') {
    console.log(`[sdr-worker] followup ${conversationId} #${attempt} → noop (${decision.reason})`)
    return
  }

  await executeFollowUp(execDeps, decision, ctx, channel as never, attempt)
  console.log(`[sdr-worker] followup ${conversationId} #${attempt} → ${decision.action}`)
}

const worker = new Worker<SdrJobData>(
  SDR_QUEUE_NAME,
  async (job) => {
    if (job.data.kind === 'followup') {
      await handleFollowUp(job.data.conversationId, job.data.attempt ?? 1)
    } else {
      await handleJob(job.data.conversationId)
    }
  },
  {
    connection: getRedisConnection(),
    // A few concurrent qualifications; each is mostly LLM-bound I/O.
    concurrency: Number(process.env.SDR_WORKER_CONCURRENCY ?? 5),
  },
)

worker.on('ready', () => console.log('[sdr-worker] ready, listening on queue:', SDR_QUEUE_NAME))
worker.on('failed', (job, err) =>
  console.error('[sdr-worker] job failed', job?.id, err?.message),
)
worker.on('error', (err) => console.error('[sdr-worker] error', err.message))

async function shutdown() {
  console.log('[sdr-worker] shutting down…')
  await worker.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
