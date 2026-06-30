import { describe, it, expect } from 'vitest'
import { subscriptionPatchForEvent } from './webhook-apply'

describe('subscriptionPatchForEvent', () => {
  it('active sets status + period + clears trial + plan', () => {
    const patch = subscriptionPatchForEvent({ type: 'subscription_active', periodEnd: '2026-07-29' }, 'pro')
    expect(patch).toMatchObject({ status: 'active', plan_id: 'pro', current_period_end: '2026-07-29', trial_ends_at: null })
  })
  it('past_due sets only status', () => {
    expect(subscriptionPatchForEvent({ type: 'subscription_past_due' }, 'pro')).toEqual({ status: 'past_due' })
  })
  it('canceled sets only status', () => {
    expect(subscriptionPatchForEvent({ type: 'subscription_canceled' }, 'pro')).toEqual({ status: 'canceled' })
  })
})
