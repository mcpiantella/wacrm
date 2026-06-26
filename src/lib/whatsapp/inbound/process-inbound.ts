import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Provider-agnostic inbound pipeline (S6).
 *
 * Both webhooks — Meta (Cloud) and Evolution — normalise their wire
 * payload into a `NormalizedInbound` and hand it here. Everything from
 * contact resolution onward (conversation upsert, message insert,
 * broadcast-reply flagging, flow dispatch, automation triggers) is
 * identical across providers and lives here exactly once.
 *
 * Provider-specific concerns stay in the routes:
 *   - Meta: media download via the Graph API token, reactions, status
 *     receipts, swipe-reply context resolution.
 *   - Evolution: payload parsing, instance→channel routing.
 */

export type InboundContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  | 'interactive'

export interface NormalizedInbound {
  /** Tenancy — stamped on every row created downstream. */
  accountId: string
  /** Sender-of-record for NOT NULL user_id FKs (the channel's owner). */
  ownerUserId: string
  /** The channel this inbound arrived on; stamped on new conversations. */
  channelId: string | null
  /** Raw sender phone; normalised here. */
  senderPhone: string
  senderName: string
  /** Provider message id (Meta message.id / Evolution key.id). */
  providerMessageId: string
  /** When the message was sent. */
  timestamp: Date
  contentType: InboundContentType
  contentText: string | null
  mediaUrl?: string | null
  /** Button/list tap id (Meta interactive); null otherwise. */
  interactiveReplyId?: string | null
  /** Pre-resolved internal UUID of the replied-to message, if any. */
  replyToInternalId?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

const ALLOWED_CONTENT_TYPES = new Set<InboundContentType>([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
])

/**
 * Run the shared inbound pipeline for one normalised message.
 * Never throws — every failure is logged and swallowed so the webhook
 * still returns 200 and the provider doesn't retry-storm.
 */
export async function processInboundMessage(
  input: NormalizedInbound,
): Promise<void> {
  const senderPhone = normalizePhone(input.senderPhone)

  const contactOutcome = await findOrCreateContact(
    input.accountId,
    input.ownerUserId,
    senderPhone,
    input.senderName,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const conversation = await findOrCreateConversation(
    input.accountId,
    input.ownerUserId,
    contactRecord.id,
    input.channelId,
  )
  if (!conversation) return

  const contentType: InboundContentType = ALLOWED_CONTENT_TYPES.has(
    input.contentType,
  )
    ? input.contentType
    : 'text'

  // First-ever customer message? Computed before insert for accuracy.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: input.contentText,
    media_url: input.mediaUrl ?? null,
    message_id: input.providerMessageId,
    status: 'delivered',
    created_at: input.timestamp.toISOString(),
    reply_to_message_id: input.replyToInternalId ?? null,
    interactive_reply_id: input.interactiveReplyId ?? null,
  })

  if (msgError) {
    console.error('[inbound] Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: input.contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound] Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(input.accountId, contactRecord.id)

  // Flow runner dispatch. Awaited because the `consumed` result decides
  // whether content-level automation triggers fire.
  const flowResult = await dispatchInboundToFlows({
    accountId: input.accountId,
    userId: input.ownerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: input.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: input.interactiveReplyId,
          reply_title: input.contentText ?? '',
          meta_message_id: input.providerMessageId,
        }
      : {
          kind: 'text',
          text: input.contentText ?? '',
          meta_message_id: input.providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = input.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: input.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }
}

export async function findOrCreateContact(
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race against a concurrent delivery — re-resolve instead of
    // dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  accountId: string,
  ownerUserId: string,
  contactId: string,
  channelId: string | null,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    // Stamp the channel on a previously channel-less conversation so the
    // inbox knows which number this thread is on. Existing channel_id is
    // left intact.
    if (channelId && !existing.channel_id) {
      await supabaseAdmin()
        .from('conversations')
        .update({ channel_id: channelId })
        .eq('id', existing.id)
      existing.channel_id = channelId
    }
    return existing
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel_id: channelId,
    })
    .select()
    .single()

  if (createError) {
    console.error('[inbound] Error creating conversation:', createError)
    return null
  }

  return newConv
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny failed:', err)
  }
}
