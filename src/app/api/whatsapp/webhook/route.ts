import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getCloudConfigByPhoneNumberId } from '@/lib/whatsapp/channel/resolve'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  processInboundMessage,
  findOrCreateContact,
  findOrCreateConversation,
  type InboundContentType,
} from '@/lib/whatsapp/inbound/process-inbound'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all Cloud channels to check verify tokens. verify_token now
    // lives in channels.config (was whatsapp_config.verify_token).
    const { data: channelRows, error: configError } = await supabaseAdmin()
      .from('channels')
      .select('id, config')
      .eq('provider', 'cloud')

    if (configError || !channelRows) {
      console.error('Error fetching channels for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    const configs = channelRows.map(
      (r: { id: string; config: { verify_token?: string } | null }) => ({
        id: r.id,
        verify_token: r.config?.verify_token ?? null,
      }),
    )

    // Check if any channel's verify_token matches. The legacy CBC→GCM
    // self-heal that ran here wrote whatsapp_config; with verify_token
    // in channels.config JSONB it's deferred to the channels write path.
    // decrypt() still reads any legacy CBC ciphertext transparently.
    let matched = false
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matched = true
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matched) {
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process asynchronously so we can ack Meta within their timeout.
  processWebhook(body).catch((error) => {
    console.error('Error processing webhook:', error)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find the Cloud channel that owns this phone_number_id (=
      // identifier). channels.UNIQUE(provider, identifier) guarantees at
      // most one, so the old ≥2-rows defensive branch is gone — the
      // constraint makes that state unreachable.
      const { data: config, error: configError } =
        await getCloudConfigByPhoneNumberId(supabaseAdmin(), phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching channel for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!config) {
        console.error('No channel found for phone_number_id:', phoneNumberId)
        continue
      }

      // user_id is the sender-of-record for inbound inserts that carry a
      // NOT NULL user_id FK. channels.user_id is ON DELETE SET NULL, so a
      // channel whose creator was deleted has none — we can't attribute
      // the inserts, so drop with a clear, actionable log. The config
      // route always sets user_id on save, so this is rare.
      if (!config.user_id) {
        console.error(
          'Channel has no owner user_id for phone_number_id:',
          phoneNumberId,
          '— inbound dropped. Re-save the WhatsApp configuration in Settings.',
        )
        continue
      }

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          // The channel this inbound arrived on (stamped on new convos).
          config.id,
          decryptedAccessToken
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
    return
  }
  if (!recipient) return // message wasn't part of a broadcast — fine

  // Guard transitions — forward-only on the success ladder, and
  // `failed` only from pre-delivered states.
  if (!isValidStatusTransition(recipient.status, status.status)) return

  const update: Record<string, unknown> = { status: status.status }
  if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  const { error: recUpdateErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id)

  if (recUpdateErr) {
    console.error('Error updating broadcast recipient status:', recUpdateErr)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched channel; every row created
  // downstream is stamped with this.
  accountId: string,
  // Sender-of-record for NOT NULL user_id FKs. The channel owner.
  configOwnerUserId: string,
  // The channel this inbound arrived on.
  channelId: string,
  accessToken: string
) {
  // Reactions short-circuit — they aren't messages. Resolve contact +
  // conversation (shared helpers) just enough to record the reaction,
  // then return before any parse/insert.
  if (message.type === 'reaction') {
    const contactOutcome = await findOrCreateContact(
      accountId,
      configOwnerUserId,
      normalizePhone(message.from),
      contact.profile.name,
    )
    if (!contactOutcome) return
    const conversation = await findOrCreateConversation(
      accountId,
      configOwnerUserId,
      contactOutcome.contact.id,
      channelId,
    )
    if (!conversation) return
    await handleReaction(message, conversation.id, contactOutcome.contact.id)
    return
  }

  // Parse Meta-specific content (downloads media via the Graph token).
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)
  // `mediaType` only drives the proxy URL inside parseMessageContent;
  // the messages schema has no media_type column.
  void mediaType

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we store NULL and the UI renders the message without a quote. This
  // needs the conversation, so resolve it here (Meta-specific lookup).
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    const conv = await findOrCreateConversation(
      accountId,
      configOwnerUserId,
      (await findOrCreateContact(
        accountId,
        configOwnerUserId,
        normalizePhone(message.from),
        contact.profile.name,
      ))?.contact.id ?? '',
      channelId,
    )
    if (conv) {
      replyToInternalId = await lookupInternalIdByMetaId(
        message.context.id,
        conv.id,
      )
      if (!replyToInternalId) {
        console.warn('[webhook] reply context parent not found:', message.context.id)
      }
    }
  }

  // Map Meta's type onto an allowed content_type, then hand the
  // normalised message to the shared provider-agnostic pipeline.
  const contentType: InboundContentType =
    message.type === 'sticker'
      ? 'image'
      : (
            [
              'text', 'image', 'document', 'audio', 'video',
              'location', 'template', 'interactive',
            ] as const
          ).includes(message.type as InboundContentType)
        ? (message.type as InboundContentType)
        : 'text'

  await processInboundMessage({
    accountId,
    ownerUserId: configOwnerUserId,
    channelId,
    senderPhone: message.from,
    senderName: contact.profile.name,
    providerMessageId: message.id,
    timestamp: new Date(parseInt(message.timestamp) * 1000),
    contentType,
    contentText: contentText ?? message.text?.body ?? null,
    mediaUrl,
    interactiveReplyId,
    replyToInternalId,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

