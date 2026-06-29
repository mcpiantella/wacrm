import type { SupabaseClient } from '@supabase/supabase-js'

export type BillingEventType =
  | 'trial_started'
  | 'ai_quota_consumed'
  | 'ai_quota_blocked'
  | 'contact_limit_reached'
  | 'channel_limit_reached'
  | 'subscription_status_changed'

/**
 * Best-effort audit write (service-role). Never throws — auditing must not
 * break the action it records.
 */
export async function recordBillingEvent(
  db: SupabaseClient,
  accountId: string,
  type: BillingEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from('billing_events').insert({ account_id: accountId, type, metadata })
  } catch (err) {
    console.error('[billing] event insert failed:', err)
  }
}
