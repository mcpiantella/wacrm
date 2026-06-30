import { describe, it, expect, vi } from 'vitest'
import { startCheckout } from './checkout'

// supabase-like stub. Tracks inserts; returns a configurable existing checkout row.
function makeDb(existing: { checkout_url: string } | null) {
  const inserts: unknown[] = []
  const db = {
    inserts,
    from(table: string) {
      if (table === 'plans') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'pro', price_cents: 29700, is_custom: false }, error: null }) }) }),
      }
      if (table === 'subscriptions') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { gateway_customer_id: null }, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }
      if (table === 'billing_checkouts') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }) }) }) }) }) }) }),
        insert: (row: unknown) => { inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'chk-row' }, error: null }) }) } },
      }
      throw new Error('unexpected table ' + table)
    },
  }
  return db as never
}

const gateway = { createCheckout: vi.fn().mockResolvedValue({ checkoutId: 'chk_1', checkoutUrl: 'https://pay/chk_1' }), cancelSubscription: vi.fn(), parseWebhook: vi.fn() }

describe('startCheckout', () => {
  it('reuses a recent started checkout instead of calling the gateway', async () => {
    gateway.createCheckout.mockClear()
    const db = makeDb({ checkout_url: 'https://pay/existing' })
    const res = await startCheckout({ db, gateway, accountId: 'acc-1', planId: 'pro', origin: 'https://app' })
    expect(res.checkoutUrl).toBe('https://pay/existing')
    expect(gateway.createCheckout).not.toHaveBeenCalled()
  })
  it('creates a new checkout and persists a billing_checkouts row', async () => {
    gateway.createCheckout.mockClear()
    const db = makeDb(null)
    const res = await startCheckout({ db, gateway, accountId: 'acc-1', planId: 'pro', origin: 'https://app' })
    expect(res.checkoutUrl).toBe('https://pay/chk_1')
    expect(gateway.createCheckout).toHaveBeenCalledOnce()
    expect((db as unknown as { inserts: { gateway_checkout_id?: string }[] }).inserts[0].gateway_checkout_id).toBe('chk_1')
  })
})
