import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideFromContext } from './core'
import type { SdrContext, SdrDeps, SdrMessage } from './types'

let transcribe: ReturnType<typeof vi.fn>
let chat: ReturnType<typeof vi.fn>
let deps: SdrDeps

beforeEach(() => {
  transcribe = vi.fn()
  chat = vi.fn()
  deps = { transcribe, chat } as unknown as SdrDeps
})

let seq = 0
function msg(
  sender_type: SdrMessage['sender_type'],
  content_text: string | null,
  extra: Partial<SdrMessage> = {},
): SdrMessage {
  seq += 1
  return {
    id: `m${seq}`,
    sender_type,
    content_type: 'text',
    content_text,
    media_url: null,
    created_at: new Date(seq * 1000).toISOString(),
    ...extra,
  }
}

function ctx(over: Partial<SdrContext> = {}): SdrContext {
  return {
    conversation: {
      id: 'conv-1',
      account_id: 'acc-1',
      contact_id: 'c-1',
      channel_id: 'ch-1',
      broadcast_id: 'b-1',
      sdr_status: 'active',
      ...(over.conversation ?? {}),
    },
    config: over.config !== undefined ? over.config : {
      enabled: true,
      system_prompt: 'Você é um SDR.',
      qualification_criteria: [],
      model: null,
      handoff_keywords: ['falar com humano'],
      max_turns: 20,
    },
    contact: { id: 'c-1', name: 'Lead', phone: '+551', ...(over.contact ?? {}) },
    messages: over.messages ?? [msg('customer', 'oi')],
  }
}

const okReply = () => ({ text: '{"reply":"olá!","handoff":false}', provider: 'openai' as const, model: 'm' })

describe('decideFromContext — guards', () => {
  it('noop when sdr_status is not active', async () => {
    const d = await decideFromContext(ctx({ conversation: { sdr_status: 'off' } as never }), deps)
    expect(d.action).toBe('noop')
    expect(chat).not.toHaveBeenCalled()
  })

  it('noop when there is no campaign link', async () => {
    const d = await decideFromContext(ctx({ conversation: { broadcast_id: null } as never }), deps)
    expect(d.action).toBe('noop')
  })

  it('noop when config is missing or disabled', async () => {
    expect((await decideFromContext(ctx({ config: null }), deps)).action).toBe('noop')
    expect(
      (await decideFromContext(ctx({ config: { enabled: false } as never }), deps)).action,
    ).toBe('noop')
  })

  it('noop when the last message is not from the customer', async () => {
    const d = await decideFromContext(
      ctx({ messages: [msg('customer', 'oi'), msg('bot', 'olá!')] }),
      deps,
    )
    expect(d.action).toBe('noop')
    expect(chat).not.toHaveBeenCalled()
  })

  it('noop when max_turns is reached', async () => {
    const d = await decideFromContext(
      ctx({
        config: { enabled: true, system_prompt: '', qualification_criteria: [], model: null, handoff_keywords: [], max_turns: 1 },
        messages: [msg('customer', 'a'), msg('bot', 'b'), msg('customer', 'c')],
      }),
      deps,
    )
    expect(d.action).toBe('noop')
    expect(d.reason).toMatch(/max_turns/)
  })
})

describe('decideFromContext — handoff', () => {
  it('hands off on a keyword without calling the LLM', async () => {
    const d = await decideFromContext(
      ctx({ messages: [msg('customer', 'quero FALAR COM HUMANO agora')] }),
      deps,
    )
    expect(d.action).toBe('handoff')
    expect(d.reason).toMatch(/keyword/)
    expect(chat).not.toHaveBeenCalled()
  })

  it('hands off when the model requests it', async () => {
    chat.mockResolvedValue({ text: '{"handoff":true,"qualification":{"hot":true}}', provider: 'openai', model: 'm' })
    const d = await decideFromContext(ctx({ messages: [msg('customer', 'me liga')] }), deps)
    expect(d.action).toBe('handoff')
    expect(d.qualification).toEqual({ hot: true })
  })
})

describe('decideFromContext — reply', () => {
  it('replies with the model text', async () => {
    chat.mockResolvedValue(okReply())
    const d = await decideFromContext(ctx({ messages: [msg('customer', 'qual o preço?')] }), deps)
    expect(d.action).toBe('reply')
    expect(d.replyText).toBe('olá!')
    expect(d.inboundMessageIds.length).toBe(1)
  })

  it('noop when the model returns an empty reply', async () => {
    chat.mockResolvedValue({ text: '{"reply":"   ","handoff":false}', provider: 'openai', model: 'm' })
    expect((await decideFromContext(ctx(), deps)).action).toBe('noop')
  })

  it('noop when the model output is not valid JSON', async () => {
    chat.mockResolvedValue({ text: 'desculpe, não consegui', provider: 'openai', model: 'm' })
    expect((await decideFromContext(ctx(), deps)).action).toBe('noop')
  })
})

describe('decideFromContext — audio + shaping', () => {
  it('transcribes audio and feeds the transcript to the LLM', async () => {
    transcribe.mockResolvedValue('quero um orçamento')
    chat.mockResolvedValue(okReply())
    const audio = msg('customer', null, { content_type: 'audio', media_url: 'https://x/a.ogg' })
    const d = await decideFromContext(ctx({ messages: [audio] }), deps)

    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x/a.ogg' }))
    expect(d.transcriptIn).toBe('quero um orçamento')
    const sent = chat.mock.calls[0][0]
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'quero um orçamento' })
  })

  it('drops a leading assistant (broadcast opener) so the LLM starts with user', async () => {
    chat.mockResolvedValue(okReply())
    await decideFromContext(
      ctx({ messages: [msg('bot', 'Oi! Vi seu interesse…'), msg('customer', 'oi')] }),
      deps,
    )
    const sent = chat.mock.calls[0][0]
    expect(sent.messages[0].role).toBe('user')
  })
})
