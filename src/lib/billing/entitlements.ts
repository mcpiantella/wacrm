export interface PlanLimits {
  max_numbers: number
  max_contacts: number
  max_ai_messages: number
}
export interface SubscriptionRow {
  status: 'trialing' | 'active' | 'past_due' | 'canceled'
  plan_id: string
  trial_ends_at: string | null
  current_period_end: string | null
  ai_messages_used: number
  cycle_reset_at: string
}
export interface Entitlements {
  active: boolean
  blocked: boolean
  canDispatch: boolean
  canUseSdr: boolean
  limits: PlanLimits
  aiUsed: number
  aiRemaining: number
  trialDaysLeft: number | null
  reason: string
}

const DAY_MS = 86_400_000

/**
 * Pure entitlement resolution from a subscription + its plan. Trial expires by
 * TIME only; a hit AI cap blocks SDR but not dispatch and never changes status.
 * `now` is injectable for tests.
 */
export function resolveEntitlements(
  sub: SubscriptionRow,
  plan: PlanLimits,
  now: number = Date.now(),
): Entitlements {
  const trialing = sub.status === 'trialing'
  const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null
  const active =
    sub.status === 'active' || (trialing && trialEnds !== null && now <= trialEnds)

  const cycleReset = new Date(sub.cycle_reset_at).getTime()
  const aiUsed = now > cycleReset ? 0 : sub.ai_messages_used
  const aiRemaining = Math.max(0, plan.max_ai_messages - aiUsed)

  const canDispatch = active
  const canUseSdr = active && aiRemaining > 0
  const trialDaysLeft =
    trialing && trialEnds !== null ? Math.max(0, Math.ceil((trialEnds - now) / DAY_MS)) : null

  let reason = ''
  if (!active) {
    reason =
      sub.status === 'past_due' ? 'past_due' : sub.status === 'canceled' ? 'canceled' : 'trial_expired'
  } else if (aiRemaining === 0) {
    reason = 'ai_quota_exceeded'
  }

  return {
    active,
    blocked: !active,
    canDispatch,
    canUseSdr,
    limits: plan,
    aiUsed,
    aiRemaining,
    trialDaysLeft,
    reason,
  }
}
