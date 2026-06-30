import crypto from 'node:crypto'
import { BillingError } from '../errors'
import type { BillingGateway, CreateCheckoutInput } from './types'

function baseUrl() { return process.env.ASAAS_BASE_URL ?? 'https://api-sandbox.asaas.com/v3' }
function headers() {
  return {
    'content-type': 'application/json',
    'access_token': process.env.ASAAS_API_KEY ?? '',
    'User-Agent': `ZenithSender/${process.env.npm_package_version ?? '0'} (${process.env.NODE_ENV ?? 'dev'})`,
  }
}

async function asaasFetch(path: string, init: RequestInit) {
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
  } catch {
    throw new BillingError('gateway_error', 'Asaas request failed')
  }
  if (!res.ok) throw new BillingError('gateway_error', `Asaas ${res.status}`)
  return res.json()
}

// Event → status maps. Confirmed against real Asaas sandbox webhook payloads.
const PAST_DUE = new Set(['PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'])
const CANCELED = new Set(['PAYMENT_REFUNDED', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'])
const ACTIVE_PAYMENT = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])

export const asaasGateway: BillingGateway = {
  async createCheckout(input: CreateCheckoutInput) {
    // Asaas Checkout (recurring): the amount lives in `items`, the recurrence in
    // `subscription` (cycle + first due date). No card/customerData here — the
    // hosted page collects them. `externalReference` carries our account id so we
    // can link the resulting subscription/payment webhooks back to the account.
    const body = {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      minutesToExpire: 60,
      callback: { successUrl: input.successUrl, cancelUrl: input.cancelUrl, expiredUrl: input.expiredUrl },
      items: [{ name: input.itemName, description: input.itemName, quantity: 1, value: input.value }],
      subscription: { cycle: input.cycle, nextDueDate: new Date().toISOString().slice(0, 10) },
      externalReference: input.accountId,
    }
    const json = await asaasFetch('/checkouts', { method: 'POST', body: JSON.stringify(body) })
    const id = json.id
    const url = json.link ?? json.url ?? json.checkoutUrl
    if (!id || !url) throw new BillingError('gateway_error', 'Asaas checkout response missing id/url')
    return {
      checkoutId: String(id),
      checkoutUrl: String(url),
      gatewayCustomerId: extractCustomerId(json.customer),
    }
  },

  async cancelSubscription(subscriptionId) {
    await asaasFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' })
  },

  async parseWebhook(req) {
    const expected = process.env.ASAAS_WEBHOOK_TOKEN ?? ''
    if (!expected) return null
    const token = req.headers.get('asaas-access-token') ?? ''
    if (!constantTimeEqual(token, expected)) return null
    const body = (await req.json().catch(() => null)) as {
      event?: string
      payment?: Record<string, unknown>
      subscription?: Record<string, unknown>
    } | null
    if (!body?.event) return null

    // Asaas sends either a `payment` object (PAYMENT_* events) or a `subscription`
    // object (SUBSCRIPTION_* events). The subscription payload carries
    // `checkoutSession` — the id we stored as billing_checkouts.gateway_checkout_id —
    // which is how the FIRST activation links back to the account (externalReference
    // is not propagated by Asaas Checkout). Renewals link via the subscription id.
    const subObj = body.subscription
    const payObj = body.payment
    const gatewaySubscriptionId = subObj?.id
      ? String(subObj.id)
      : payObj?.subscription
        ? String(payObj.subscription)
        : undefined
    const gatewayCheckoutId = subObj?.checkoutSession ? String(subObj.checkoutSession) : undefined
    const periodEnd = subObj?.nextDueDate
      ? String(subObj.nextDueDate)
      : payObj?.dueDate
        ? String(payObj.dueDate)
        : new Date().toISOString()

    const ev = body.event
    if (ev === 'SUBSCRIPTION_CREATED' || ev === 'SUBSCRIPTION_UPDATED') {
      const status = subObj?.status ? String(subObj.status) : ''
      if (status === 'ACTIVE') return { type: 'subscription_active', gatewaySubscriptionId, gatewayCheckoutId, periodEnd }
      if (status === 'INACTIVE' || status === 'EXPIRED') return { type: 'subscription_canceled', gatewaySubscriptionId, gatewayCheckoutId }
      return null
    }
    if (ACTIVE_PAYMENT.has(ev)) return { type: 'subscription_active', gatewaySubscriptionId, gatewayCheckoutId, periodEnd }
    if (PAST_DUE.has(ev)) return { type: 'subscription_past_due', gatewaySubscriptionId, gatewayCheckoutId }
    if (CANCELED.has(ev)) return { type: 'subscription_canceled', gatewaySubscriptionId, gatewayCheckoutId }
    return null
  },
}

/** Asaas may return `customer` as a string id or as `{ id: '...' }`. */
function extractCustomerId(customer: unknown): string | undefined {
  if (typeof customer === 'string' && customer) return customer
  if (customer && typeof customer === 'object' && 'id' in customer) {
    const id = (customer as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

/** Constant-time string compare (avoids leaking via early return). */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on unequal lengths — bail early.
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}
