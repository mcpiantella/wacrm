import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Provider-agnostic chat completion with an OpenAI → Anthropic fallback.
 *
 * Used by the SDR (qualifier) and the campaign generator. OpenAI is the
 * primary (default model `gpt-5.4-mini`, overridable via `OPENAI_MODEL`);
 * Anthropic is the fallback when OpenAI has no key or errors at call time.
 *
 * Keys come from env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — never
 * hardcoded. If neither is configured, callers get a clear error.
 *
 * Note on history shape: Anthropic requires the first message to be a
 * `user` turn and roles to alternate. When a caller passes a history that
 * might start with `assistant` (e.g. an SDR opener), it must shape it
 * before calling — this layer is a thin transport, not a conversation
 * normaliser.
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatCompleteInput {
  /** System prompt. */
  system: string
  /** Conversation turns (user/assistant), in order. */
  messages: ChatMessage[]
  /** Override the model id (else provider default). */
  model?: string
  /** Ask the model to return a single JSON object. */
  json?: boolean
  /** Anthropic requires a max; default 2000. Ignored for OpenAI (gpt-5
   *  family uses max_completion_tokens — we let the model default). */
  maxTokens?: number
}

export interface ChatCompleteResult {
  text: string
  provider: 'openai' | 'anthropic'
  model: string
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'

async function openaiComplete(input: ChatCompleteInput): Promise<ChatCompleteResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const model = input.model ?? DEFAULT_OPENAI_MODEL
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    ...(input.json ? { response_format: { type: 'json_object' as const } } : {}),
  })
  return {
    text: res.choices[0]?.message?.content ?? '',
    provider: 'openai',
    model,
  }
}

async function anthropicComplete(input: ChatCompleteInput): Promise<ChatCompleteResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const model = input.model ?? DEFAULT_ANTHROPIC_MODEL
  const system = input.json
    ? `${input.system}\n\nResponda APENAS com um objeto JSON válido, sem texto fora dele.`
    : input.system
  const res = await client.messages.create({
    model,
    max_tokens: input.maxTokens ?? 2000,
    system,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
  })
  const block = res.content[0]
  return {
    text: block && block.type === 'text' ? block.text : '',
    provider: 'anthropic',
    model,
  }
}

/**
 * Run a chat completion, preferring OpenAI and falling back to Anthropic.
 *
 *   - OpenAI key present → try it; on error, fall back to Anthropic (if
 *     that key exists) rather than failing the whole call.
 *   - OpenAI key absent → go straight to Anthropic.
 *   - Neither key → throw a clear configuration error.
 *   - OpenAI fails AND no Anthropic key → rethrow the OpenAI error (so the
 *     real cause surfaces, not a misleading "not configured").
 */
export async function chatComplete(input: ChatCompleteInput): Promise<ChatCompleteResult> {
  let openaiError: unknown = null

  if (process.env.OPENAI_API_KEY) {
    try {
      return await openaiComplete(input)
    } catch (err) {
      openaiError = err
      console.warn(
        '[ai/chat] OpenAI failed, falling back to Anthropic:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return await anthropicComplete(input)
  }

  if (openaiError) throw openaiError
  throw new Error(
    'No LLM provider configured: set OPENAI_API_KEY and/or ANTHROPIC_API_KEY.',
  )
}

/**
 * Best-effort extraction of a JSON object from model output. Tolerates
 * ```json fences and leading/trailing prose by grabbing the outermost
 * `{ … }`. Throws if nothing parses.
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // fall through to brace extraction
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T
  }
  throw new Error('Model output did not contain valid JSON')
}

/** Convenience: run a JSON completion and parse it. */
export async function chatCompleteJson<T = unknown>(
  input: ChatCompleteInput,
): Promise<T> {
  const { text } = await chatComplete({ ...input, json: true })
  return extractJson<T>(text)
}
