import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { transcriptionsCreate, toFileMock } = vi.hoisted(() => ({
  transcriptionsCreate: vi.fn(),
  toFileMock: vi.fn(async (data: unknown, name: string, opts?: { type?: string }) => ({
    name,
    type: opts?.type,
  })),
}))

vi.mock('openai', () => ({
  default: class {
    audio = { transcriptions: { create: transcriptionsCreate } }
  },
  toFile: toFileMock,
}))

import { OpenAITranscriber } from './openai-transcriber'
import { getTranscriber } from './factory'

describe('OpenAITranscriber', () => {
  beforeEach(() => {
    transcriptionsCreate.mockReset()
    toFileMock.mockClear()
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('transcribes raw bytes and returns the text', async () => {
    transcriptionsCreate.mockResolvedValue({ text: 'olá, quero saber o preço' })
    const t = new OpenAITranscriber()
    const out = await t.transcribe({
      bytes: new TextEncoder().encode('fake-audio').buffer,
      mimeType: 'audio/ogg',
    })
    expect(out).toBe('olá, quero saber o preço')
    expect(transcriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini-transcribe', language: 'pt' }),
    )
    // filename extension derives from the mime type
    expect(toFileMock).toHaveBeenCalledWith(expect.anything(), 'audio.ogg', { type: 'audio/ogg' })
  })

  it('downloads the audio when only a url is given', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      )
    transcriptionsCreate.mockResolvedValue({ text: 'baixado e transcrito' })

    const t = new OpenAITranscriber()
    const out = await t.transcribe({ url: 'https://x/audio.ogg', mimeType: 'audio/ogg' })

    expect(out).toBe('baixado e transcrito')
    expect(fetchMock).toHaveBeenCalledWith('https://x/audio.ogg')
  })

  it('throws when the download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    const t = new OpenAITranscriber()
    await expect(
      t.transcribe({ url: 'https://x/missing.ogg', mimeType: 'audio/ogg' }),
    ).rejects.toThrow(/Failed to download audio \(404\)/)
  })

  it('throws when neither bytes nor url is provided', async () => {
    const t = new OpenAITranscriber()
    await expect(t.transcribe({ mimeType: 'audio/ogg' })).rejects.toThrow(
      /requires either bytes or a url/,
    )
  })
})

describe('getTranscriber', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('returns an OpenAITranscriber by default', () => {
    vi.stubEnv('TRANSCRIBER', '')
    expect(getTranscriber()).toBeInstanceOf(OpenAITranscriber)
  })

  it('throws a clear "not implemented" error for groq', () => {
    vi.stubEnv('TRANSCRIBER', 'groq')
    expect(() => getTranscriber()).toThrow(/not implemented yet/)
  })
})
