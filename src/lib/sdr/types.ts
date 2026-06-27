import type { ChatCompleteInput, ChatCompleteResult } from '@/lib/ai/chat'
import type { TranscribeInput } from '@/lib/ai/transcription/types'

/** A conversation message, as the SDR needs it (subset of `messages`). */
export interface SdrMessage {
  id: string
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  media_url: string | null
  created_at: string
}

/** Everything `decideFromContext` needs — loaded once from the DB. */
export interface SdrContext {
  conversation: {
    id: string
    account_id: string
    contact_id: string
    channel_id: string | null
    broadcast_id: string | null
    sdr_status: 'off' | 'active' | 'handoff'
    user_id: string
  }
  config: {
    enabled: boolean
    system_prompt: string | null
    qualification_criteria: unknown
    model: string | null
    handoff_keywords: string[]
    max_turns: number
    follow_up_enabled: boolean
    /** Reminder offsets in minutes from the bot's awaiting message. */
    follow_up_delays: number[]
    cold_tag: string
  } | null
  contact: { id: string; name: string | null; phone: string | null }
  /** Full history, ordered oldest → newest. */
  messages: SdrMessage[]
}

export type SdrAction = 'reply' | 'handoff' | 'noop'

export interface SdrDecision {
  action: SdrAction
  /** Short machine-ish reason, for the sdr_runs log. */
  reason: string
  /** Present when action === 'reply'. */
  replyText?: string
  /** Whatever qualification signal the model emitted. */
  qualification?: unknown
  /** Transcript of an inbound audio, if one was transcribed. */
  transcriptIn?: string | null
  /** Inbound message ids this decision consumed (for the log). */
  inboundMessageIds: string[]
  /** Raw model output (parsed JSON), for debugging. */
  raw?: unknown
}

export type FollowUpDecision =
  | { action: 'noop'; reason: string }
  | { action: 'cold'; reason: string }
  | { action: 'send'; text: string; final: boolean }

/** Injected side-effect deps — keeps the core pure and testable. */
export interface SdrDeps {
  transcribe: (input: TranscribeInput) => Promise<string>
  chat: (input: ChatCompleteInput) => Promise<ChatCompleteResult>
}
