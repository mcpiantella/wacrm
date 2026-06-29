import type { SupabaseClient } from '@supabase/supabase-js'
import { BillingError, mapPgBillingError } from './errors'

/**
 * Atomically consume one AI message for the account (the SQL function does the
 * check + increment under a row lock). Returns the remaining quota, or throws a
 * typed BillingError ('billing_blocked' | 'ai_quota_exceeded'). Unrelated DB
 * errors are rethrown as-is.
 */
export async function consumeAiMessageOrThrow(
  db: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { data, error } = await db.rpc('consume_ai_message', { p_account: accountId })
  if (error) {
    const code = mapPgBillingError(error)
    if (code) throw new BillingError(code)
    throw error
  }
  return data as number
}
