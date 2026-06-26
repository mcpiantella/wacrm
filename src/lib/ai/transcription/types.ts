/**
 * Audio transcription for the SDR — leads often reply with voice notes,
 * and the qualifier needs text. Kept behind an interface so the provider
 * (OpenAI today; Groq/Deepgram later) is a one-line swap.
 */

export interface TranscribeInput {
  /** Public URL the provider/we can fetch the audio from. */
  url?: string
  /** Raw audio bytes (used when we already have them in hand). */
  bytes?: ArrayBuffer
  /** MIME type, e.g. 'audio/ogg' — drives the upload filename/extension. */
  mimeType: string
  /** ISO-639-1 language hint, e.g. 'pt'. Improves accuracy. */
  language?: string
}

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<string>
}
