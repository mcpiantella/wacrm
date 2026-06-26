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
import { SDR_QUEUE_NAME, type SdrJobData } from '@/lib/queue/sdr-queue'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { chatComplete } from '@/lib/ai/chat'
import { getTranscriber } from '@/lib/ai/transcription/factory'
import { loadSdrContext, decideFromContext } from '@/lib/sdr/core'
import { executeDecision, type ExecuteDeps } from '@/lib/sdr/execute'
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
  const decision = await decideFromContext(ctx, sdrDeps)
  await executeDecision(execDeps, decision, ctx)
  console.log(`[sdr-worker] ${conversationId} → ${decision.action} (${decision.reason})`)
}

const worker = new Worker<SdrJobData>(
  SDR_QUEUE_NAME,
  async (job) => {
    await handleJob(job.data.conversationId)
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
