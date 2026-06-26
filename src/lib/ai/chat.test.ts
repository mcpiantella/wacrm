import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { openaiCreate, anthropicCreate } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
}))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } }
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))

import { chatComplete, extractJson, chatCompleteJson } from './chat'

function openaiReply(content: string) {
  return { choices: [{ message: { content } }] }
}
function anthropicReply(text: string) {
  return { content: [{ type: 'text', text }] }
}

describe('chatComplete', () => {
  beforeEach(() => {
    openaiCreate.mockReset()
    anthropicCreate.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('uses OpenAI when its key is present', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_API_KEY', 'an-test')
    openaiCreate.mockResolvedValue(openaiReply('hi from openai'))

    const res = await chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }] })

    expect(res).toEqual({ text: 'hi from openai', provider: 'openai', model: 'gpt-5.4-mini' })
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('falls back to Anthropic when OpenAI throws', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_API_KEY', 'an-test')
    openaiCreate.mockRejectedValue(new Error('429 rate limit'))
    anthropicCreate.mockResolvedValue(anthropicReply('hi from claude'))

    const res = await chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }] })

    expect(res.provider).toBe('anthropic')
    expect(res.text).toBe('hi from claude')
  })

  it('goes straight to Anthropic when OpenAI key is absent', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', 'an-test')
    anthropicCreate.mockResolvedValue(anthropicReply('claude only'))

    const res = await chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }] })

    expect(res.provider).toBe('anthropic')
    expect(openaiCreate).not.toHaveBeenCalled()
  })

  it('throws a clear error when no provider is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    await expect(
      chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }] }),
    ).rejects.toThrow(/No LLM provider configured/)
  })

  it('rethrows the OpenAI error when OpenAI fails and there is no Anthropic key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    openaiCreate.mockRejectedValue(new Error('boom from openai'))
    await expect(
      chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }] }),
    ).rejects.toThrow(/boom from openai/)
  })

  it('passes response_format when json:true (OpenAI)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    openaiCreate.mockResolvedValue(openaiReply('{}'))
    await chatComplete({ system: 's', messages: [{ role: 'user', content: 'oi' }], json: true })
    expect(openaiCreate).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: { type: 'json_object' } }),
    )
  })
})

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('parses JSON inside ```json fences with prose', () => {
    const text = 'Claro!\n```json\n{"reply":"oi","handoff":false}\n```\nabraço'
    expect(extractJson(text)).toEqual({ reply: 'oi', handoff: false })
  })
  it('throws when there is no JSON', () => {
    expect(() => extractJson('sem json aqui')).toThrow(/did not contain valid JSON/)
  })
})

describe('chatCompleteJson', () => {
  beforeEach(() => {
    openaiCreate.mockReset()
    anthropicCreate.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('runs a json completion and parses the result', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    openaiCreate.mockResolvedValue(openaiReply('{"reply":"olá","handoff":false}'))
    const out = await chatCompleteJson<{ reply: string; handoff: boolean }>({
      system: 's',
      messages: [{ role: 'user', content: 'oi' }],
    })
    expect(out).toEqual({ reply: 'olá', handoff: false })
  })
})
