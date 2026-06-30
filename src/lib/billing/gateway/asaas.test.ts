import { describe, it, expect, vi, beforeEach } from 'vitest'
import { asaasGateway } from './asaas'

const ENV = { ASAAS_BASE_URL: 'https://api-sandbox.asaas.com/v3', ASAAS_API_KEY: 'k', ASAAS_WEBHOOK_TOKEN: 'tok' }
beforeEach(() => { Object.assign(process.env, ENV); vi.restoreAllMocks() })

function webhookReq(body: unknown, token = 'tok') {
  return new Request('https://x/api/billing/webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('asaasGateway.createCheckout', () => {
  it('POSTs a recurrent credit-card checkout and returns the hosted url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'chk_1', link: 'https://asaas/checkout/chk_1' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await asaasGateway.createCheckout({
      accountId: 'acc-1', planId: 'pro', itemName: 'Pro', value: 297, cycle: 'MONTHLY',
      successUrl: 's', cancelUrl: 'c', expiredUrl: 'e', customer: { name: 'Acme' },
    })
    expect(res.checkoutId).toBe('chk_1')
    expect(res.checkoutUrl).toContain('chk_1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api-sandbox.asaas.com/v3/checkouts')
    expect((init.headers as Record<string, string>)['access_token']).toBe('k')
    const sent = JSON.parse(init.body as string)
    expect(sent.billingTypes).toEqual(['CREDIT_CARD'])
    expect(sent.chargeTypes).toEqual(['RECURRENT'])
    expect(sent.subscription.cycle).toBe('MONTHLY')
    expect(sent.subscription.nextDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(sent.items[0]).toMatchObject({ name: 'Pro', quantity: 1, value: 297 })
    expect(sent.value).toBeUndefined()
    expect(sent.externalReference).toBe('acc-1')
  })
  it('maps a 4xx into a BillingError(gateway_error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ errors: [] }) }))
    await expect(asaasGateway.createCheckout({
      accountId: 'a', planId: 'pro', itemName: 'Pro', value: 1, cycle: 'MONTHLY', successUrl: 's', cancelUrl: 'c', expiredUrl: 'e',
    })).rejects.toMatchObject({ code: 'gateway_error' })
  })
  it('rejects when the response is missing the checkout url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'chk_1' }) }))
    await expect(asaasGateway.createCheckout({
      accountId: 'a', planId: 'pro', itemName: 'Pro', value: 1, cycle: 'MONTHLY', successUrl: 's', cancelUrl: 'c', expiredUrl: 'e',
    })).rejects.toMatchObject({ code: 'gateway_error' })
  })
  it('extracts gatewayCustomerId from a nested customer object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'chk_1', link: 'https://asaas/checkout/chk_1', customer: { id: 'cus_9' } }),
    }))
    const res = await asaasGateway.createCheckout({
      accountId: 'a', planId: 'pro', itemName: 'Pro', value: 1, cycle: 'MONTHLY', successUrl: 's', cancelUrl: 'c', expiredUrl: 'e',
    })
    expect(res.gatewayCustomerId).toBe('cus_9')
  })
})

describe('asaasGateway.parseWebhook', () => {
  it('rejects a bad token', async () => {
    expect(await asaasGateway.parseWebhook(webhookReq({ event: 'PAYMENT_CONFIRMED' }, 'WRONG'))).toBeNull()
  })
  it('rejects when ASAAS_WEBHOOK_TOKEN is empty (never authenticate against blank token)', async () => {
    const saved = process.env.ASAAS_WEBHOOK_TOKEN
    delete process.env.ASAAS_WEBHOOK_TOKEN
    try {
      expect(await asaasGateway.parseWebhook(webhookReq({ event: 'PAYMENT_CONFIRMED' }, ''))).toBeNull()
    } finally {
      process.env.ASAAS_WEBHOOK_TOKEN = saved
    }
  })
  it('PAYMENT_CONFIRMED -> subscription_active', async () => {
    const ev = await asaasGateway.parseWebhook(webhookReq({
      event: 'PAYMENT_CONFIRMED',
      payment: { subscription: 'sub_1', dueDate: '2026-07-29', externalReference: 'acc-1' },
    }))
    expect(ev).toMatchObject({ type: 'subscription_active', gatewaySubscriptionId: 'sub_1' })
  })
  it.each([
    ['PAYMENT_OVERDUE', 'subscription_past_due'],
    ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'subscription_past_due'],
    ['PAYMENT_CHARGEBACK_REQUESTED', 'subscription_past_due'],
    ['PAYMENT_CHARGEBACK_DISPUTE', 'subscription_past_due'],
    ['PAYMENT_REFUNDED', 'subscription_canceled'],
    ['PAYMENT_DELETED', 'subscription_canceled'],
    ['SUBSCRIPTION_DELETED', 'subscription_canceled'],
  ])('%s -> %s', async (event, type) => {
    const ev = await asaasGateway.parseWebhook(webhookReq({ event, payment: { subscription: 'sub_1' } }))
    expect(ev?.type).toBe(type)
  })
  it('ignores unknown events', async () => {
    expect(await asaasGateway.parseWebhook(webhookReq({ event: 'PAYMENT_PARTIALLY_REFUNDED' }))).toBeNull()
  })
})
