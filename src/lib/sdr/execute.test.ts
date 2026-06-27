/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeDecision, executeFollowUp, type ExecuteDeps } from './execute'
import type { SdrContext, SdrDecision, FollowUpDecision } from './types'

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
      user_id: 'u-1',
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

function fakeSupabase() {
  const calls: Record<string, unknown[]> = { update: [], insert: [], upsert: [], select: [] }
  const make = (table: string): any => {
    const chain: any = {}
    chain.update = (v: unknown) => { calls.update.push({ table, v }); return chain }
    chain.insert = (v: unknown) => { calls.insert.push({ table, v }); return chain }
    chain.upsert = (v: unknown, o: unknown) => { calls.upsert.push({ table, v, o }); return chain }
    chain.select = () => chain
    chain.eq = () => chain
    chain.ilike = () => chain
    chain.maybeSingle = async () => ({ data: table === 'tags' ? { id: 'tag1' } : null, error: null })
    chain.single = async () => ({ data: { id: 'msg1' }, error: null })
    return chain
  }
  return { from: (t: string) => make(t), _calls: calls }
}

const ctxFU = {
  conversation: { id: 'c1', account_id: 'a1', contact_id: 'ct1', channel_id: 'ch1', broadcast_id: 'b1', sdr_status: 'active' as const, user_id: 'u1' },
  config: { enabled: true, system_prompt: '', qualification_criteria: [], model: null, handoff_keywords: [], max_turns: 20, follow_up_enabled: true, follow_up_delays: [180, 1440], cold_tag: 'lead-frio' },
  contact: { id: 'ct1', name: 'Lead', phone: '5511999' },
  messages: [],
}
const channelFU = { id: 'ch1', account_id: 'a1', user_id: 'u1', provider: 'evolution', identifier: 'inst', display_name: 'x', phone_e164: null, status: 'connected', config: {}, credentials: {} }

describe('executeFollowUp', () => {
  it('sends a non-final reminder and logs a followup run', async () => {
    const sup = fakeSupabase()
    const send = vi.fn().mockResolvedValue({ messageId: 'wamid' })
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]
    const decision: FollowUpDecision = { action: 'send', text: 'oi de novo', final: false }

    await executeFollowUp(deps, decision, ctxFU as never, channelFU as never, 1)

    expect(send).toHaveBeenCalledWith(channelFU, '5511999', 'oi de novo')
    const inserts = sup._calls.insert.map((c: any) => (c.v as any).action ?? (c.v as any).sender_type)
    expect(inserts).toContain('bot')      // reminder message
    expect(inserts).toContain('followup') // run row
    const offUpdate = sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')
    expect(offUpdate).toBeUndefined()     // not final → no cold close
  })

  it('on the final reminder also closes cold (sdr_status off + tag)', async () => {
    const sup = fakeSupabase()
    const send = vi.fn().mockResolvedValue({ messageId: 'wamid' })
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]

    await executeFollowUp(deps, { action: 'send', text: 'última', final: true }, ctxFU as never, channelFU as never, 2)

    expect(sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')).toBeDefined()
    expect(sup._calls.upsert.some((c: any) => c.table === 'contact_tags')).toBe(true)
  })

  it('cold decision closes without sending', async () => {
    const sup = fakeSupabase()
    const send = vi.fn()
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]

    await executeFollowUp(deps, { action: 'cold', reason: 'window' }, ctxFU as never, channelFU as never, 1)

    expect(send).not.toHaveBeenCalled()
    expect(sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')).toBeDefined()
  })
})
