import type { SupabaseClient } from '@supabase/supabase-js'
import { BillingError } from './errors'
import { resolveAllowedModels } from '../ai/model-registry'

const FALLBACK_KEYS = ['budget_default']

/** Resolve the account plan's allowed concrete models. Falls back to budget. */
export async function getPlanAllowedModels(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data: sub } = await db
    .from('subscriptions').select('plan_id').eq('account_id', accountId).maybeSingle()
  const planId = (sub as { plan_id?: string } | null)?.plan_id
  let keys = FALLBACK_KEYS
  if (planId) {
    const { data: plan } = await db
      .from('plans').select('allowed_model_keys').eq('id', planId).maybeSingle()
    const k = (plan as { allowed_model_keys?: string[] } | null)?.allowed_model_keys
    if (Array.isArray(k) && k.length) keys = k
  }
  return resolveAllowedModels(keys)
}

/** Throw BillingError('model_not_allowed') if `model` is set and not in the plan. */
export async function assertModelAllowed(db: SupabaseClient, accountId: string, model: string | null): Promise<void> {
  if (!model) return
  const allowed = await getPlanAllowedModels(db, accountId)
  if (!allowed.includes(model)) throw new BillingError('model_not_allowed')
}
