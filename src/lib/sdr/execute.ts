import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelRow } from '@/lib/whatsapp/channel/types'
import type { SdrContext, SdrDecision, FollowUpDecision } from './types'

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

export const CHANNEL_COLUMNS =
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

/**
 * Execute a follow-up decision (separate from executeDecision so the
 * qualify path stays untouched). The worker passes the already-loaded
 * channel — no second fetch. `send` persists a bot reminder + a 'followup'
 * run; a `final` send (or a `cold` decision) then closes the thread cold.
 */
export async function executeFollowUp(
  deps: ExecuteDeps,
  decision: FollowUpDecision,
  ctx: SdrContext,
  channel: ChannelRow | null,
  attempt: number,
): Promise<void> {
  const { supabase } = deps
  const { conversation, contact } = ctx

  try {
    if (decision.action === 'noop') return

    if (decision.action === 'cold') {
      await closeCold(deps, ctx)
      return
    }

    // action === 'send'
    if (!channel || !contact.phone) {
      await logFollowUpRun(deps, ctx, 'error', `missing ${!channel ? 'channel' : 'phone'}`)
      return
    }

    const { messageId } = await deps.sendOnChannel(channel, contact.phone, decision.text)
    const { data: inserted } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: 'text',
        content_text: decision.text,
        message_id: messageId,
        status: 'sent',
      })
      .select('id')
      .single()
    await supabase
      .from('conversations')
      .update({
        last_message_text: decision.text,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)
    await logFollowUpRun(deps, ctx, 'followup', null, inserted?.id ?? null)

    if (decision.final) await closeCold(deps, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logFollowUpRun(deps, ctx, 'error', `followup attempt ${attempt}: ${message}`).catch(() => undefined)
  }
}

/** Flip sdr_status off and tag the contact cold. Logs a 'cold' run. */
async function closeCold(deps: ExecuteDeps, ctx: SdrContext): Promise<void> {
  const { supabase } = deps
  const { conversation, contact, config } = ctx
  await supabase
    .from('conversations')
    .update({ sdr_status: 'off', updated_at: new Date().toISOString() })
    .eq('id', conversation.id)

  const tagName = config?.cold_tag?.trim()
  if (tagName && contact.id) {
    const tagId = await findOrCreateTag(deps, conversation.account_id, conversation.user_id, tagName)
    if (tagId) {
      await supabase
        .from('contact_tags')
        .upsert(
          { contact_id: contact.id, tag_id: tagId },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
    }
  }
  await logFollowUpRun(deps, ctx, 'cold', null)
}

/** Find-or-create a tag by name for an account; returns its id or null. */
async function findOrCreateTag(
  deps: ExecuteDeps,
  accountId: string,
  userId: string,
  name: string,
): Promise<string | null> {
  const { supabase } = deps
  const { data: existing } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', name)
    .maybeSingle()
  if (existing?.id) return existing.id as string

  // `tags` has NOT NULL user_id + account_id; color defaults in the DB.
  const { data: created } = await supabase
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name, color: '#64748b' })
    .select('id')
    .single()
  return (created?.id as string) ?? null
}

async function logFollowUpRun(
  deps: ExecuteDeps,
  ctx: SdrContext,
  action: 'followup' | 'cold' | 'error',
  error: string | null,
  replyMessageId: string | null = null,
): Promise<void> {
  await deps.supabase.from('sdr_runs').insert({
    account_id: ctx.conversation.account_id,
    conversation_id: ctx.conversation.id,
    broadcast_id: ctx.conversation.broadcast_id,
    inbound_message_ids: [],
    action,
    reply_message_id: replyMessageId,
    error,
  })
}
