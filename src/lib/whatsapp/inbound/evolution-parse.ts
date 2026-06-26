/**
 * Pure parser for Evolution API webhook payloads (messages.upsert).
 *
 * Evolution's shape varies a little across versions; this normalises the
 * common cases into the fields the shared inbound pipeline needs, and
 * returns null for anything we deliberately ignore (group chats, our own
 * outbound echoes, non-text messages, malformed bodies).
 *
 * Text-only for now — media/audio normalisation (the SDR consumes audio
 * via Groq) is a follow-up.
 */

export interface ParsedEvolutionInbound {
  instance: string
  senderPhone: string
  senderName: string
  providerMessageId: string
  text: string
  timestamp: Date
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

function firstDataEntry(body: AnyObj): AnyObj | null {
  const data = body?.data
  if (!data) return null
  // Evolution sends either a single object or an array of them.
  if (Array.isArray(data)) return data.length > 0 ? data[0] : null
  return data
}

/** Strip the WhatsApp JID suffix to get the bare number. */
function phoneFromJid(jid: string): string | null {
  if (typeof jid !== 'string') return null
  // Group chats end in @g.us — not a 1:1 contact, skip.
  if (jid.endsWith('@g.us')) return null
  const at = jid.indexOf('@')
  const bare = at === -1 ? jid : jid.slice(0, at)
  // Some JIDs carry a device suffix like "5511...:12" — drop it.
  return bare.split(':')[0] || null
}

function extractText(message: AnyObj | undefined): string | null {
  if (!message) return null
  if (typeof message.conversation === 'string') return message.conversation
  if (typeof message.extendedTextMessage?.text === 'string') {
    return message.extendedTextMessage.text
  }
  return null
}

export function parseEvolutionInbound(
  body: AnyObj,
): ParsedEvolutionInbound | null {
  const event = body?.event
  // Accept only message-upsert events (be tolerant of dot/underscore).
  if (event && !/messages[._]upsert/i.test(String(event))) return null

  const instance = body?.instance
  if (typeof instance !== 'string' || instance.length === 0) return null

  const entry = firstDataEntry(body)
  if (!entry) return null

  // Skip our own outbound echoes.
  if (entry.key?.fromMe === true) return null

  const senderPhone = phoneFromJid(entry.key?.remoteJid)
  if (!senderPhone) return null

  const providerMessageId = entry.key?.id
  if (typeof providerMessageId !== 'string' || providerMessageId.length === 0) {
    return null
  }

  const text = extractText(entry.message)
  if (text === null) return null // non-text (media/audio) — follow-up

  const tsRaw = entry.messageTimestamp
  const tsSeconds =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string' && /^\d+$/.test(tsRaw)
        ? parseInt(tsRaw, 10)
        : null
  const timestamp = tsSeconds ? new Date(tsSeconds * 1000) : new Date()

  const senderName =
    typeof entry.pushName === 'string' && entry.pushName.length > 0
      ? entry.pushName
      : senderPhone

  return {
    instance,
    senderPhone,
    senderName,
    providerMessageId,
    text,
    timestamp,
  }
}
