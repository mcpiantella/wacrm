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

// NOTE: verify exact /checkouts path + field names against live Asaas docs.
const PAST_DUE = new Set(['PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'])
const CANCELED = new Set(['PAYMENT_REFUNDED', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED'])
const ACTIVE = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])

export const asaasGateway: BillingGateway = {
  async createCheckout(input: CreateCheckoutInput) {
    const body = {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      subscription: { cycle: input.cycle },
      value: input.value,
      externalReference: input.accountId,
      callback: { successUrl: input.successUrl, cancelUrl: input.cancelUrl, expiredUrl: input.expiredUrl },
      ...(input.customer ? { customerData: { name: input.customer.name, email: input.customer.email } } : {}),
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
    const token = req.headers.get('asaas-access-token') ?? ''
    const expected = process.env.ASAAS_WEBHOOK_TOKEN ?? ''
    if (!timingSafeEqual(token, expected)) return null
    const body = (await req.json().catch(() => null)) as { event?: string; payment?: Record<string, unknown> } | null
    if (!body?.event) return null
    const sub = body.payment?.subscription ? String(body.payment.subscription) : undefined
    const periodEnd = body.payment?.dueDate ? String(body.payment.dueDate) : new Date().toISOString()
    if (ACTIVE.has(body.event)) return { type: 'subscription_active', gatewaySubscriptionId: sub, periodEnd }
    if (PAST_DUE.has(body.event)) return { type: 'subscription_past_due', gatewaySubscriptionId: sub }
    if (CANCELED.has(body.event)) return { type: 'subscription_canceled', gatewaySubscriptionId: sub }
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
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
