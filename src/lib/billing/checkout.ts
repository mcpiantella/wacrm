import type { SupabaseClient } from '@supabase/supabase-js'
import type { BillingGateway } from './gateway/types'
import { BillingError } from './errors'

const IDEMPOTENCY_MINUTES = 30

interface StartCheckoutArgs {
  db: SupabaseClient
  gateway: BillingGateway
  accountId: string
  planId: string
  origin: string // e.g. https://app.host — used to build callback URLs
}

/** Start a hosted recurring checkout. Never mutates `subscriptions`. */
export async function startCheckout(args: StartCheckoutArgs): Promise<{ checkoutUrl: string }> {
  const { db, gateway, accountId, planId, origin } = args

  const { data: plan } = await db
    .from('plans').select('id, price_cents, is_custom').eq('id', planId).maybeSingle()
  const p = plan as { id: string; price_cents: number; is_custom: boolean } | null
  if (!p || p.is_custom || p.price_cents <= 0) throw new BillingError('plan_limit_reached', 'Plano inválido para checkout.')

  // Idempotency: reuse a recent started checkout for the same account+plan.
  const since = new Date(Date.now() - IDEMPOTENCY_MINUTES * 60_000).toISOString()
  const { data: existing } = await db
    .from('billing_checkouts')
    .select('checkout_url').eq('account_id', accountId).eq('target_plan_id', planId).eq('status', 'started')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing && (existing as { checkout_url?: string }).checkout_url) {
    return { checkoutUrl: (existing as { checkout_url: string }).checkout_url }
  }

  const { data: sub } = await db
    .from('subscriptions').select('gateway_customer_id').eq('account_id', accountId).maybeSingle()
  const customerId = (sub as { gateway_customer_id?: string } | null)?.gateway_customer_id ?? undefined

  const back = `${origin}/settings?tab=billing`
  const checkout = await gateway.createCheckout({
    accountId, planId, value: p.price_cents / 100, cycle: 'MONTHLY',
    successUrl: back, cancelUrl: back, expiredUrl: back,
    customer: { customerId, name: accountId },
  })

  await db.from('billing_checkouts').insert({
    account_id: accountId, target_plan_id: planId, gateway: 'asaas',
    gateway_checkout_id: checkout.checkoutId, checkout_url: checkout.checkoutUrl, status: 'started',
  }).select('id').single()

  return { checkoutUrl: checkout.checkoutUrl }
}
