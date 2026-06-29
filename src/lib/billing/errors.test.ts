import { describe, it, expect } from 'vitest'
import { BillingError, billingErrorResponse, mapPgBillingError } from './errors'

describe('billing errors', () => {
  it('maps a Postgres error message to a code', () => {
    expect(mapPgBillingError({ message: 'ai_quota_exceeded' })).toBe('ai_quota_exceeded')
    expect(mapPgBillingError({ message: 'contact_limit_reached (P0001)' })).toBe('contact_limit_reached')
    expect(mapPgBillingError({ message: 'something else' })).toBeNull()
  })
  it('builds a response with the right status + body', async () => {
    const res = billingErrorResponse('billing_blocked')
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('billing_blocked')
    expect(typeof body.error.message).toBe('string')
    expect(billingErrorResponse('channel_limit_reached').status).toBe(403)
  })
  it('BillingError carries the code', () => {
    expect(new BillingError('ai_quota_exceeded').code).toBe('ai_quota_exceeded')
  })
})
