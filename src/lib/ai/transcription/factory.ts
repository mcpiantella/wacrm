import type { Transcriber } from './types'
import { OpenAITranscriber } from './openai-transcriber'

/**
 * Resolve the configured transcription provider. `TRANSCRIBER` env
 * selects it (default `openai`); Groq/Deepgram are reserved for a future
 * swap and fail loudly until implemented rather than silently no-op.
 */
export function getTranscriber(): Transcriber {
  const provider = process.env.TRANSCRIBER || 'openai'
  switch (provider) {
    case 'openai':
      return new OpenAITranscriber()
    case 'groq':
    case 'deepgram':
      throw new Error(`Transcriber '${provider}' is not implemented yet.`)
    default:
      throw new Error(`Unknown transcriber: ${provider}`)
  }
}
