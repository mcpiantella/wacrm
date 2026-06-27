import { describe, it, expect, vi } from 'vitest'
import { decideFollowUp } from './followup'
import type { SdrContext, SdrDeps } from './types'

function ctx(over: Partial<SdrContext> = {}): SdrContext {
  return {
    conversation: { id: 'c1', account_id: 'a1', contact_id: 'ct1', channel_id: 'ch1', broadcast_id: 'b1', sdr_status: 'active', user_id: 'u1' },
    config: {
      enabled: true, system_prompt: 'Você é um SDR', qualification_criteria: [], model: null,
      handoff_keywords: [], max_turns: 20, follow_up_enabled: true, follow_up_delays: [180, 1440], cold_tag: 'lead-frio',
    },
    contact: { id: 'ct1', name: 'Lead', phone: '5511999' },
    messages: [
      { id: 'm1', sender_type: 'customer', content_type: 'text', content_text: 'oi', media_url: null, created_at: '2026-06-27T00:00:00Z' },
      { id: 'm2', sender_type: 'bot', content_type: 'text', content_text: 'Qual seu orçamento?', media_url: null, created_at: '2026-06-27T00:01:00Z' },
    ],
    ...over,
  }
}
const deps = (text = 'Oi! Ainda tem interesse?'): SdrDeps => ({
  transcribe: vi.fn(),
  chat: vi.fn().mockResolvedValue({ text, provider: 'openai', model: 'gpt-4o-mini' }),
})

describe('decideFollowUp', () => {
  it('sends a reminder when the lead is silent (last msg = bot)', async () => {
    const d = deps()
    const out = await decideFollowUp(ctx(), 1, 'evolution', d)
    expect(out).toEqual({ action: 'send', text: 'Oi! Ainda tem interesse?', final: false })
    expect(d.chat).toHaveBeenCalledOnce()
  })

  it('marks final on the last attempt', async () => {
    const out = await decideFollowUp(ctx(), 2, 'evolution', deps())
    expect(out).toMatchObject({ action: 'send', final: true })
  })

  it('no-ops if the customer already replied (last msg = customer)', async () => {
    const c = ctx()
    c.messages.push({ id: 'm3', sender_type: 'customer', content_type: 'text', content_text: 'voltei', media_url: null, created_at: '2026-06-27T02:00:00Z' })
    const d = deps()
    const out = await decideFollowUp(c, 1, 'evolution', d)
    expect(out.action).toBe('noop')
    expect(d.chat).not.toHaveBeenCalled()
  })

  it('no-ops when sdr_status is not active', async () => {
    const out = await decideFollowUp(ctx({ conversation: { ...ctx().conversation, sdr_status: 'handoff' } }), 1, 'evolution', deps())
    expect(out.action).toBe('noop')
  })

  it('no-ops when follow_up disabled', async () => {
    const c = ctx(); c.config!.follow_up_enabled = false
    const out = await decideFollowUp(c, 1, 'evolution', deps())
    expect(out.action).toBe('noop')
  })

  it('closes cold without an LLM call on cloud outside the 24h window', async () => {
    const d = deps()
    const now = new Date('2026-06-27T01:01:00Z').getTime() + 25 * 60 * 60_000
    const out = await decideFollowUp(ctx(), 1, 'cloud', d, now)
    expect(out.action).toBe('cold')
    expect(d.chat).not.toHaveBeenCalled()
  })

  it('still sends on cloud INSIDE the 24h window', async () => {
    const now = new Date('2026-06-27T03:00:00Z').getTime()
    const out = await decideFollowUp(ctx(), 1, 'cloud', deps(), now)
    expect(out.action).toBe('send')
  })
})
