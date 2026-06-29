import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getGateway } from '@/lib/billing/gateway'
import { recordBillingEvent } from '@/lib/billing/events'
import { subscriptionPatchForEvent } from '@/lib/billing/webhook-apply'

/** POST /api/billing/webhook — Asaas events. Always 200 once token is valid. */
export async function POST(request: Request) {
  const gateway = getGateway()
  const raw = await request.text()
  const headers = request.headers
  let eventId: string | null = null
  try { eventId = (JSON.parse(raw) as { id?: string }).id ?? null } catch { eventId = null }

  const db = supabaseAdmin()
  const ev = await gateway.parseWebhook(new Request(request.url, { method: 'POST', headers, body: raw }))
  if (!ev) return NextResponse.json({ ok: true }) // bad token or ignored event -> 200, no state change

  if (eventId) {
    const { error } = await db.from('billing_webhook_events').insert({ event_id: eventId })
    if (error) return NextResponse.json({ ok: true, duplicate: true }) // PK conflict => already processed
  }

  let accountId: string | null = null
  let targetPlanId: string | null = null

  type CheckoutRow = { account_id: string; target_plan_id: string | null; id: string } | null

  // Resolve account from checkout: try gateway_subscription_id first, then gateway_checkout_id.
  // Two sequential .eq() lookups chosen over .or() for clean type-checking with conditional fields.
  if (ev.gatewaySubscriptionId || ev.gatewayCheckoutId) {
    let chkRow: CheckoutRow = null

    if (ev.gatewaySubscriptionId) {
      const { data } = await db
        .from('billing_checkouts')
        .select('account_id, target_plan_id, id')
        .eq('gateway_subscription_id', ev.gatewaySubscriptionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      chkRow = data as CheckoutRow
    }

    if (!chkRow && ev.gatewayCheckoutId) {
      const { data } = await db
        .from('billing_checkouts')
        .select('account_id, target_plan_id, id')
        .eq('gateway_checkout_id', ev.gatewayCheckoutId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      chkRow = data as CheckoutRow
    }

    if (chkRow) {
      accountId = chkRow.account_id ?? null
      targetPlanId = chkRow.target_plan_id ?? null
      if (ev.type === 'subscription_active' && chkRow.id) {
        await db.from('billing_checkouts').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          ...(ev.gatewaySubscriptionId ? { gateway_subscription_id: ev.gatewaySubscriptionId } : {}),
        }).eq('id', chkRow.id)
      }
    }
  }

  if (!accountId && ev.gatewaySubscriptionId) {
    const { data: sub } = await db
      .from('subscriptions')
      .select('account_id')
      .eq('gateway_subscription_id', ev.gatewaySubscriptionId)
      .maybeSingle()
    accountId = (sub as { account_id?: string } | null)?.account_id ?? null
  }

  if (!accountId) return NextResponse.json({ ok: true, unmatched: true })

  const patch = subscriptionPatchForEvent(ev, targetPlanId)
  await db.from('subscriptions').update({ ...patch, updated_at: new Date().toISOString() }).eq('account_id', accountId)
  await recordBillingEvent(db, accountId, 'subscription_status_changed', { event: ev.type })

  return NextResponse.json({ ok: true })
}
