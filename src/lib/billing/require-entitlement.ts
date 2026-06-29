import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccountEntitlements } from './load-entitlements'
import { billingErrorResponse } from './errors'

/**
 * Returns a billing error response if the account can't dispatch, else null.
 * Usage: `const blocked = await requireDispatch(db, accountId); if (blocked) return blocked;`
 */
export async function requireDispatch(
  db: SupabaseClient,
  accountId: string,
): Promise<NextResponse | null> {
  const ent = await getAccountEntitlements(db, accountId)
  if (!ent.canDispatch) return billingErrorResponse('billing_blocked')
  return null
}
