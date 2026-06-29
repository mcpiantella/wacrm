import { describe, it, expect } from 'vitest'
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from './entitlements'

const plan: PlanLimits = { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 }
const DAY = 86_400_000
const base = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: 'trialing', plan_id: 'trial',
  trial_ends_at: new Date(Date.now() + 3 * DAY).toISOString(),
  current_period_end: null, ai_messages_used: 0,
  cycle_reset_at: new Date(Date.now() + 10 * DAY).toISOString(),
  ...over,
})

describe('resolveEntitlements', () => {
  it('trialing within window is active and can dispatch + use SDR', () => {
    const e = resolveEntitlements(base(), plan)
    expect(e.active).toBe(true)
    expect(e.canDispatch).toBe(true)
    expect(e.canUseSdr).toBe(true)
    expect(e.trialDaysLeft).toBe(3)
  })
  it('expired trial (time only) is blocked', () => {
    const e = resolveEntitlements(base({ trial_ends_at: new Date(Date.now() - DAY).toISOString() }), plan)
    expect(e.active).toBe(false)
    expect(e.blocked).toBe(true)
    expect(e.canDispatch).toBe(false)
    expect(e.canUseSdr).toBe(false)
    expect(e.reason).toBe('trial_expired')
  })
  it('a hit AI cap blocks SDR but NOT dispatch, and does not expire the trial', () => {
    const e = resolveEntitlements(base({ ai_messages_used: 50 }), plan)
    expect(e.active).toBe(true)
    expect(e.canDispatch).toBe(true)
    expect(e.canUseSdr).toBe(false)
    expect(e.aiRemaining).toBe(0)
    expect(e.reason).toBe('ai_quota_exceeded')
  })
  it('past_due / canceled are blocked', () => {
    expect(resolveEntitlements(base({ status: 'past_due' }), plan).canDispatch).toBe(false)
    expect(resolveEntitlements(base({ status: 'canceled' }), plan).reason).toBe('canceled')
  })
  it('lazy cycle reset: past cycle_reset_at, quota reads as fresh', () => {
    const e = resolveEntitlements(
      base({ status: 'active', trial_ends_at: null, ai_messages_used: 50, cycle_reset_at: new Date(Date.now() - DAY).toISOString() }),
      plan,
    )
    expect(e.aiUsed).toBe(0)
    expect(e.aiRemaining).toBe(50)
    expect(e.canUseSdr).toBe(true)
  })
})
