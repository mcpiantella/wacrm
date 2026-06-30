export interface CreateCheckoutInput {
  accountId: string
  planId: string
  itemName: string // human label for the charge line item (the plan name)
  value: number // monthly price in BRL (reais, not cents)
  cycle: 'MONTHLY'
  successUrl: string
  cancelUrl: string
  expiredUrl: string
  customer?: { customerId?: string; name: string; email?: string }
}

export interface BillingGateway {
  /** Create a hosted recurring checkout. The subscription id arrives later via webhook. */
  createCheckout(input: CreateCheckoutInput): Promise<{
    checkoutId: string
    checkoutUrl: string
    gatewayCustomerId?: string
  }>
  cancelSubscription(subscriptionId: string): Promise<void>
  /** Map a provider webhook request to a normalized event (or null to ignore). */
  parseWebhook(req: Request): Promise<BillingWebhookEvent | null>
}

export type BillingWebhookEvent =
  | { type: 'subscription_active'; gatewayCheckoutId?: string; gatewaySubscriptionId?: string; periodEnd: string }
  | { type: 'subscription_past_due'; gatewayCheckoutId?: string; gatewaySubscriptionId?: string }
  | { type: 'subscription_canceled'; gatewayCheckoutId?: string; gatewaySubscriptionId?: string }
