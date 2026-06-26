import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeDecision, type ExecuteDeps } from './execute'
import type { SdrContext, SdrDecision } from './types'

/**
 * Minimal Supabase fake. `insert`/`update` return thenable builders so
 * both `await from().insert()` and `from().insert().select().single()`
 * work, matching the PostgREST builder shape.
 */
function makeSupabase(opts: { channel?: unknown; channelErr?: unknown } = {}) {
  const calls = {
    runs: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    convUpdates: [] as Record<string, unknown>[],
  }
  const supabase = {
    from(table: string) {
      return {
        select() {
          return this
        },
        eq() {
          return this
        },
        maybeSingle() {
          if (table === 'channels') {
            return Promise.resolve({ data: opts.channel ?? null, error: opts.channelErr ?? null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        insert(payload: Record<string, unknown>) {
          if (table === 'sdr_runs') calls.runs.push(payload)
          if (table === 'messages') calls.messages.push(payload)
          const result = { data: table === 'messages' ? { id: 'msg-internal-1' } : null, error: null }
          return {
            select() {
              return { single: () => Promise.resolve(result) }
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              return Promise.resolve(result).then(onF, onR)
            },
          }
        },
        update(payload: Record<string, unknown>) {
          calls.convUpdates.push({ table, ...payload })
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
  }
  return { supabase, calls }
}

function ctx(over: Partial<SdrContext['conversation']> = {}): SdrContext {
  return {
    conversation: {
      id: 'conv-1',
      account_id: 'acc-1',
      contact_id: 'c-1',
      channel_id: 'ch-1',
      broadcast_id: 'b-1',
      sdr_status: 'active',
      ...over,
    },
    config: null,
    contact: { id: 'c-1', name: 'Lead', phone: '+5511999999999' },
    messages: [],
  }
}

const replyDecision: SdrDecision = {
  action: 'reply',
  reason: 'ok',
  replyText: 'Olá! Como posso ajudar?',
  inboundMessageIds: ['m1'],
  raw: { reply: 'Olá! Como posso ajudar?' },
}

let sendOnChannel: ReturnType<typeof vi.fn>
let notify: ReturnType<typeof vi.fn>

beforeEach(() => {
  sendOnChannel = vi.fn().mockResolvedValue({ messageId: 'wamid.OUT' })
  notify = vi.fn().mockResolvedValue(undefined)
})

describe('executeDecision', () => {
  it('reply: sends on the channel, persists a bot message, logs a reply run', async () => {
    const { supabase, calls } = makeSupabase({ channel: { id: 'ch-1', provider: 'evolution' } })
    const deps = { supabase: supabase as never, sendOnChannel, notify } as unknown as ExecuteDeps

    await executeDecision(deps, replyDecision, ctx())

    expect(sendOnChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch-1' }),
      '+5511999999999',
      'Olá! Como posso ajudar?',
    )
    expect(calls.messages[0]).toMatchObject({ sender_type: 'bot', content_text: 'Olá! Como posso ajudar?', message_id: 'wamid.OUT' })
    expect(calls.runs[0]).toMatchObject({ action: 'reply', reply_message_id: 'msg-internal-1' })
  })

  it('handoff: flips sdr_status, notifies, logs a handoff run', async () => {
    const { supabase, calls } = makeSupabase()
    const deps = { supabase: supabase as never, sendOnChannel, notify } as unknown as ExecuteDeps

    await executeDecision(
      deps,
      { action: 'handoff', reason: 'kw', inboundMessageIds: ['m1'] },
      ctx(),
    )

    expect(calls.convUpdates.find((u) => u.sdr_status === 'handoff')).toBeTruthy()
    expect(notify).toHaveBeenCalled()
    expect(calls.runs[0]).toMatchObject({ action: 'handoff' })
    expect(sendOnChannel).not.toHaveBeenCalled()
  })

  it('noop: logs only', async () => {
    const { supabase, calls } = makeSupabase()
    const deps = { supabase: supabase as never, sendOnChannel } as unknown as ExecuteDeps
    await executeDecision(deps, { action: 'noop', reason: 'x', inboundMessageIds: [] }, ctx())
    expect(calls.runs[0]).toMatchObject({ action: 'noop' })
    expect(sendOnChannel).not.toHaveBeenCalled()
  })

  it('reply with no channel on the conversation logs an error run', async () => {
    const { supabase, calls } = makeSupabase()
    const deps = { supabase: supabase as never, sendOnChannel } as unknown as ExecuteDeps
    await executeDecision(deps, replyDecision, ctx({ channel_id: null }))
    expect(calls.runs[0]).toMatchObject({ action: 'error' })
    expect(sendOnChannel).not.toHaveBeenCalled()
  })

  it('a send failure is captured as an error run, not a throw', async () => {
    const { supabase, calls } = makeSupabase({ channel: { id: 'ch-1' } })
    sendOnChannel.mockRejectedValue(new Error('Connection Closed'))
    const deps = { supabase: supabase as never, sendOnChannel } as unknown as ExecuteDeps

    await expect(executeDecision(deps, replyDecision, ctx())).resolves.toBeUndefined()
    expect(calls.runs[0]).toMatchObject({ action: 'error' })
    expect(calls.runs[0].error).toMatch(/Connection Closed/)
  })
})
