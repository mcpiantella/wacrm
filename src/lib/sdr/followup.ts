import { toLlmMessages } from './core'
import type { SdrContext, SdrDeps, FollowUpDecision, SdrMessage } from './types'

const WINDOW_MS = 24 * 60 * 60 * 1000

const FOLLOWUP_INSTRUCTION = `

# Follow-up
O lead parou de responder. Escreva UMA mensagem curta e gentil reengajando,
retomando o contexto da conversa. Não repita a última pergunta literalmente.
Responda apenas com a mensagem, sem JSON e sem aspas.`

function lastCustomerMs(messages: SdrMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_type === 'customer') {
      return new Date(messages[i].created_at).getTime()
    }
  }
  return 0
}

/**
 * Pure follow-up decision. The worker supplies `channelProvider` (and may
 * inject `nowMs` for tests). No DB/side effects — it only reads ctx and may
 * call the injected `chat` to draft the reminder.
 */
export async function decideFollowUp(
  ctx: SdrContext,
  attempt: number,
  channelProvider: string,
  deps: SdrDeps,
  nowMs: number = Date.now(),
): Promise<FollowUpDecision> {
  const { conversation, config, messages } = ctx

  if (conversation.sdr_status !== 'active') {
    return { action: 'noop', reason: `sdr_status=${conversation.sdr_status}` }
  }
  if (!config || !config.enabled || !config.follow_up_enabled) {
    return { action: 'noop', reason: 'follow-up disabled' }
  }
  const delays = config.follow_up_delays ?? []
  if (attempt < 1 || attempt > delays.length) {
    return { action: 'noop', reason: `attempt ${attempt} out of range` }
  }
  if (messages.length === 0) return { action: 'noop', reason: 'no messages' }

  // Still awaiting only if the LAST message is ours (not the customer's).
  const last = messages[messages.length - 1]
  if (last.sender_type === 'customer') {
    return { action: 'noop', reason: 'customer already replied' }
  }

  // Cloud API: free-form is blocked outside the 24h customer-service window.
  // Skip the send (and the LLM call) and let the worker close cold.
  if (channelProvider === 'cloud' && nowMs - lastCustomerMs(messages) > WINDOW_MS) {
    return { action: 'cold', reason: 'cloud 24h window closed' }
  }

  const llmMessages = toLlmMessages(messages, new Map())
  const result = await deps.chat({
    system: `${config.system_prompt ?? ''}${FOLLOWUP_INSTRUCTION}`,
    messages: llmMessages,
    model: config.model ?? undefined,
    maxTokens: 300,
  })
  const text = result.text.trim()
  if (!text) return { action: 'noop', reason: 'empty reminder' }

  return { action: 'send', text, final: attempt >= delays.length }
}
