import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getGateway } from '@/lib/billing/gateway'
import { startCheckout } from '@/lib/billing/checkout'
import { BillingError, billingErrorResponse } from '@/lib/billing/errors'

/** POST /api/billing/checkout { planId } -> { checkoutUrl } */
export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentAccount()
    const body = await request.json().catch(() => null)
    const planId = body && typeof body === 'object' ? (body as { planId?: unknown }).planId : undefined
    if (typeof planId !== 'string' || !planId) {
      return NextResponse.json({ error: 'planId é obrigatório' }, { status: 400 })
    }
    const origin = new URL(request.url).origin
    const { checkoutUrl } = await startCheckout({
      db: supabaseAdmin(), gateway: getGateway(), accountId, planId, origin,
    })
    return NextResponse.json({ checkoutUrl })
  } catch (err) {
    if (err instanceof BillingError) return billingErrorResponse(err.code)
    return toErrorResponse(err)
  }
}
