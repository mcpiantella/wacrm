import type { SupabaseClient } from '@supabase/supabase-js'
import { extractJson } from '@/lib/ai/chat'
import type {
  SdrContext,
  SdrDecision,
  SdrDeps,
  SdrMessage,
} from './types'

/**
 * The SDR brain. Pure orchestration: given a conversation's context and
 * injected deps (transcribe + chat), it decides whether to reply, hand
 * off to a human, or do nothing. NO side effects — it never sends,
 * persists, or touches the queue. The worker (SDR-6) executes the
 * returned decision.
 *
 * Split in two so the decision logic is testable without a DB:
 *   - loadSdrContext()  — the only DB-touching part.
 *   - decideFromContext() — pure; all the branches live here.
 */

interface LlmReply {
  reply?: string
  handoff?: boolean
  qualification?: unknown
}

function noop(reason: string, inboundIds: string[] = []): SdrDecision {
  return { action: 'noop', reason, inboundMessageIds: inboundIds }
}

/** The latest contiguous run of unanswered customer messages (the batch). */
function pendingCustomerMessages(messages: SdrMessage[]): SdrMessage[] {
  const out: SdrMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_type === 'customer') out.unshift(messages[i])
    else break
  }
  return out
}

function matchesHandoffKeyword(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase()
  return keywords.some((k) => k.trim() && haystack.includes(k.toLowerCase()))
}

/**
 * Map history → LLM turns. customer → user, bot/agent → assistant. Drops
 * leading assistant turns so the array starts with a user message (the
 * Anthropic fallback requires it; harmless for OpenAI). `audioTranscripts`
 * substitutes text for audio messages by id.
 */
function toLlmMessages(
  messages: SdrMessage[],
  audioTranscripts: Map<string, string>,
): { role: 'user' | 'assistant'; content: string }[] {
  const mapped = messages.map((m) => {
    const role: 'user' | 'assistant' =
      m.sender_type === 'customer' ? 'user' : 'assistant'
    let content = m.content_text?.trim() || ''
    if (!content && audioTranscripts.has(m.id)) {
      content = audioTranscripts.get(m.id) as string
    }
    if (!content) content = `[${m.content_type}]`
    return { role, content }
  })
  // Drop leading assistant turns (e.g. a broadcast opener) so the first
  // turn is the user — required by Anthropic, fine for OpenAI.
  let start = 0
  while (start < mapped.length && mapped[start].role === 'assistant') start++
  return mapped.slice(start)
}

export async function decideFromContext(
  ctx: SdrContext,
  deps: SdrDeps,
): Promise<SdrDecision> {
  const { conversation, config, messages } = ctx

  if (conversation.sdr_status !== 'active') {
    return noop(`sdr_status=${conversation.sdr_status}`)
  }
  if (!conversation.broadcast_id) {
    return noop('conversation has no campaign')
  }
  if (!config || !config.enabled) {
    return noop('sdr config missing or disabled')
  }
  if (messages.length === 0) {
    return noop('no messages')
  }

  // Don't reply to ourselves: only act when the last turn is the customer.
  const last = messages[messages.length - 1]
  if (last.sender_type !== 'customer') {
    return noop('last message is not from the customer')
  }

  // Turn limit — count our own (bot) replies.
  const botTurns = messages.filter((m) => m.sender_type === 'bot').length
  if (botTurns >= config.max_turns) {
    return noop(`max_turns reached (${botTurns}/${config.max_turns})`)
  }

  const batch = pendingCustomerMessages(messages)
  const inboundIds = batch.map((m) => m.id)

  // Transcribe any audio in the pending batch.
  const transcripts = new Map<string, string>()
  let transcriptIn: string | null = null
  for (const m of batch) {
    if (m.content_type === 'audio' && m.media_url && !m.content_text?.trim()) {
      const text = await deps.transcribe({ url: m.media_url, mimeType: 'audio/ogg' })
      transcripts.set(m.id, text)
      transcriptIn = transcriptIn ? `${transcriptIn}\n${text}` : text
    }
  }

  // Early handoff on a keyword in the inbound batch — cheaper than an LLM call.
  const batchText = batch
    .map((m) => transcripts.get(m.id) || m.content_text || '')
    .join('\n')
  if (matchesHandoffKeyword(batchText, config.handoff_keywords)) {
    return {
      action: 'handoff',
      reason: 'handoff keyword matched',
      transcriptIn,
      inboundMessageIds: inboundIds,
    }
  }

  // Ask the LLM.
  const llmMessages = toLlmMessages(messages, transcripts)
  const result = await deps.chat({
    system: config.system_prompt ?? '',
    messages: llmMessages,
    model: config.model ?? undefined,
    json: true,
  })

  let parsed: LlmReply
  try {
    parsed = extractJson<LlmReply>(result.text)
  } catch {
    return noop('model output was not valid JSON', inboundIds)
  }

  if (parsed.handoff) {
    return {
      action: 'handoff',
      reason: 'model requested handoff',
      qualification: parsed.qualification,
      transcriptIn,
      inboundMessageIds: inboundIds,
      raw: parsed,
    }
  }

  const replyText = (parsed.reply ?? '').trim()
  if (!replyText) {
    return noop('model returned an empty reply', inboundIds)
  }

  return {
    action: 'reply',
    reason: 'ok',
    replyText,
    qualification: parsed.qualification,
    transcriptIn,
    inboundMessageIds: inboundIds,
    raw: parsed,
  }
}

/** Load everything the decision needs for a conversation (service-role). */
export async function loadSdrContext(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<SdrContext | null> {
  const { data: conversation, error: convErr } = await supabase
    .from('conversations')
    .select('id, account_id, contact_id, channel_id, broadcast_id, sdr_status')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr || !conversation) return null

  const [{ data: config }, { data: contact }, { data: messages }] =
    await Promise.all([
      conversation.broadcast_id
        ? supabase
            .from('sdr_configs')
            .select(
              'enabled, system_prompt, qualification_criteria, model, handoff_keywords, max_turns',
            )
            .eq('broadcast_id', conversation.broadcast_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('id', conversation.contact_id)
        .maybeSingle(),
      supabase
        .from('messages')
        .select('id, sender_type, content_type, content_text, media_url, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }),
    ])

  return {
    conversation,
    config: (config as SdrContext['config']) ?? null,
    contact: (contact as SdrContext['contact']) ?? {
      id: conversation.contact_id,
      name: null,
      phone: null,
    },
    messages: (messages as SdrMessage[]) ?? [],
  }
}

/** Load + decide. Returns a `noop` if the conversation can't be loaded. */
export async function decideSdrAction(
  supabase: SupabaseClient,
  deps: SdrDeps,
  conversationId: string,
): Promise<SdrDecision> {
  const ctx = await loadSdrContext(supabase, conversationId)
  if (!ctx) return noop('conversation not found')
  return decideFromContext(ctx, deps)
}
