import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveEntitlements,
  type Entitlements,
  type PlanLimits,
  type SubscriptionRow,
} from './entitlements'

const FALLBACK_PLAN: PlanLimits = { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 }

/**
 * Load the account's subscription + plan and resolve entitlements. A missing
 * subscription (shouldn't happen post-backfill/trigger) is treated as blocked.
 */
export async function getAccountEntitlements(
  db: SupabaseClient,
  accountId: string,
): Promise<Entitlements> {
  const { data: sub } = await db
    .from('subscriptions')
    .select('status, plan_id, trial_ends_at, current_period_end, ai_messages_used, cycle_reset_at')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!sub) {
    return resolveEntitlements(
      {
        status: 'canceled',
        plan_id: 'trial',
        trial_ends_at: null,
        current_period_end: null,
        ai_messages_used: 0,
        cycle_reset_at: new Date().toISOString(),
      },
      FALLBACK_PLAN,
    )
  }

  const { data: plan } = await db
    .from('plans')
    .select('max_numbers, max_contacts, max_ai_messages')
    .eq('id', sub.plan_id)
    .maybeSingle()

  return resolveEntitlements(sub as SubscriptionRow, (plan as PlanLimits) ?? FALLBACK_PLAN)
}
