import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getGateway } from '@/lib/billing/gateway'
import { recordBillingEvent } from '@/lib/billing/events'
import { subscriptionPatchForEvent } from '@/lib/billing/webhook-apply'

type CheckoutRow = { account_id: string; target_plan_id: string | null; id: string } | null

/**
 * POST /api/billing/webhook — Asaas events. Always 200 once token is valid.
 *
 * Ordering is deliberate: the dedup record (billing_webhook_events) is written
 * only AFTER the subscription state change durably succeeds. This gives
 * at-least-once apply — the patch is idempotent, so an Asaas retry safely
 * re-applies if a transient write fails, and dedup only suppresses a repeated
 * audit/processing once state is committed.
 */
export async function POST(request: Request) {
  const gateway = getGateway()
  const raw = await request.text()
  const headers = request.headers
  let eventId: string | null = null
  try { eventId = (JSON.parse(raw) as { id?: string }).id ?? null } catch { eventId = null }

  const db = supabaseAdmin()
  const ev = await gateway.parseWebhook(new Request(request.url, { method: 'POST', headers, body: raw }))
  if (!ev) return NextResponse.json({ ok: true }) // bad token or ignored event -> 200, no state change

  // Read-first duplicate check: if we've already recorded this event, skip.
  // (The dedup row is written only after a successful state change, below.)
  if (eventId) {
    const { data: seen } = await db
      .from('billing_webhook_events').select('event_id').eq('event_id', eventId).maybeSingle()
    if (seen) return NextResponse.json({ ok: true, duplicate: true })
  }

  let accountId: string | null = null
  let targetPlanId: string | null = null

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
        const { error: chkErr } = await db.from('billing_checkouts').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          ...(ev.gatewaySubscriptionId ? { gateway_subscription_id: ev.gatewaySubscriptionId } : {}),
        }).eq('id', chkRow.id)
        if (chkErr) console.error('[billing/webhook] checkout complete update failed', chkErr.message)
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
  const { error: subErr } = await db
    .from('subscriptions').update({ ...patch, updated_at: new Date().toISOString() }).eq('account_id', accountId)
  if (subErr) {
    // State write failed — do NOT record the event as processed, so an Asaas
    // retry can re-apply (the patch is idempotent). Surface for ops/alerting.
    console.error('[billing/webhook] subscription update failed', subErr.message)
    return NextResponse.json({ ok: true })
  }

  // State durably applied — now safe to dedup + audit.
  if (eventId) await db.from('billing_webhook_events').insert({ event_id: eventId })
  await recordBillingEvent(db, accountId, 'subscription_status_changed', { event: ev.type })

  return NextResponse.json({ ok: true })
}
