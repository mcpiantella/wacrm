import type { BillingWebhookEvent } from './gateway/types'

/**
 * The subscription column patch for a normalized webhook event. `targetPlanId`
 * is the plan the checkout was for (only applied on activation — upgrade safety:
 * the plan only moves once payment confirms).
 */
export function subscriptionPatchForEvent(
  ev: BillingWebhookEvent,
  targetPlanId: string | null,
): Record<string, unknown> {
  switch (ev.type) {
    case 'subscription_active':
      return {
        status: 'active',
        ...(targetPlanId ? { plan_id: targetPlanId } : {}),
        current_period_end: ev.periodEnd,
        trial_ends_at: null,
        gateway: 'asaas',
        ...(ev.gatewaySubscriptionId ? { gateway_subscription_id: ev.gatewaySubscriptionId } : {}),
      }
    case 'subscription_past_due':
      return { status: 'past_due' }
    case 'subscription_canceled':
      return { status: 'canceled' }
  }
}
