import OpenAI, { toFile } from 'openai'
import type { Transcriber, TranscribeInput } from './types'

/**
 * OpenAI transcription (`gpt-4o-mini-transcribe` by default). Primary
 * because the account already uses OpenAI (one vendor, free credits) and
 * it handles pt-BR well.
 */
const DEFAULT_MODEL = process.env.TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe'

/** Map a MIME type to a filename the API can infer the format from. */
function filenameForMime(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'ogg'
  return `audio.${ext}`
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download audio (${res.status}) from ${url}`)
  }
  return res.arrayBuffer()
}

export class OpenAITranscriber implements Transcriber {
  async transcribe({ url, bytes, mimeType, language }: TranscribeInput): Promise<string> {
    if (!bytes && !url) {
      throw new Error('transcribe requires either bytes or a url')
    }
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const data = bytes ?? (await fetchBytes(url as string))
    const file = await toFile(Buffer.from(data), filenameForMime(mimeType), {
      type: mimeType,
    })
    const res = await client.audio.transcriptions.create({
      file,
      model: DEFAULT_MODEL,
      language: language ?? 'pt',
    })
    return res.text ?? ''
  }
}
