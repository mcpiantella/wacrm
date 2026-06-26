import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelRow } from '@/lib/whatsapp/channel/types'
import type { SdrContext, SdrDecision } from './types'

/**
 * Side-effecting executor for an SdrDecision. Kept separate from the
 * worker bootstrap (and from the pure core) so the branch behaviour is
 * unit-testable with a fake Supabase + injected senders.
 *
 *   reply   → send on the conversation's channel, persist the bot
 *             message, bump the conversation, log the run.
 *   handoff → flip sdr_status to 'handoff', notify (best-effort), log.
 *   noop    → log only.
 *
 * Any throw is caught and recorded as an 'error' run — a single bad job
 * must never crash the worker loop.
 */
export interface ExecuteDeps {
  supabase: SupabaseClient
  /** Send text on a channel; returns the provider message id. */
  sendOnChannel: (channel: ChannelRow, to: string, text: string) => Promise<{ messageId: string }>
  /** Best-effort operator notification (handoff/errors). */
  notify?: (accountId: string, text: string) => Promise<void>
}

const CHANNEL_COLUMNS =
  'id, account_id, user_id, provider, identifier, display_name, phone_e164, status, config, credentials'

export async function executeDecision(
  deps: ExecuteDeps,
  decision: SdrDecision,
  ctx: SdrContext,
): Promise<void> {
  const { supabase } = deps
  const { conversation, contact } = ctx

  try {
    if (decision.action === 'noop') {
      await logRun(deps, ctx, decision, { action: 'noop' })
      return
    }

    if (decision.action === 'handoff') {
      await supabase
        .from('conversations')
        .update({ sdr_status: 'handoff', updated_at: new Date().toISOString() })
        .eq('id', conversation.id)
      if (deps.notify) {
        await deps
          .notify(
            conversation.account_id,
            `🤝 Handoff: ${contact.name || contact.phone || 'lead'} precisa de um humano.`,
          )
          .catch(() => undefined)
      }
      await logRun(deps, ctx, decision, { action: 'handoff' })
      return
    }

    // action === 'reply'
    const replyText = decision.replyText ?? ''
    if (!conversation.channel_id) {
      await logRun(deps, ctx, decision, { action: 'error', error: 'conversation has no channel' })
      return
    }
    if (!contact.phone) {
      await logRun(deps, ctx, decision, { action: 'error', error: 'contact has no phone' })
      return
    }

    const { data: channel, error: chErr } = await supabase
      .from('channels')
      .select(CHANNEL_COLUMNS)
      .eq('id', conversation.channel_id)
      .maybeSingle()
    if (chErr || !channel) {
      await logRun(deps, ctx, decision, { action: 'error', error: 'channel not found' })
      return
    }

    const { messageId } = await deps.sendOnChannel(channel as ChannelRow, contact.phone, replyText)

    const { data: inserted } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: 'text',
        content_text: replyText,
        message_id: messageId,
        status: 'sent',
      })
      .select('id')
      .single()

    await supabase
      .from('conversations')
      .update({
        last_message_text: replyText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    await logRun(deps, ctx, decision, {
      action: 'reply',
      reply_message_id: inserted?.id ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logRun(deps, ctx, decision, { action: 'error', error: message }).catch(() => undefined)
  }
}

async function logRun(
  deps: ExecuteDeps,
  ctx: SdrContext,
  decision: SdrDecision,
  over: { action: SdrDecision['action'] | 'error'; reply_message_id?: string | null; error?: string },
): Promise<void> {
  await deps.supabase.from('sdr_runs').insert({
    account_id: ctx.conversation.account_id,
    conversation_id: ctx.conversation.id,
    broadcast_id: ctx.conversation.broadcast_id,
    inbound_message_ids: decision.inboundMessageIds,
    transcript_in: decision.transcriptIn ?? null,
    llm_output: (decision.raw as object) ?? null,
    action: over.action,
    reply_message_id: over.reply_message_id ?? null,
    error: over.error ?? null,
  })
}
