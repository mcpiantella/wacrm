export interface BillingGateway {
  createCustomer(input: { accountId: string; name: string; email?: string }): Promise<{ customerId: string }>
  createSubscription(input: {
    customerId: string
    planId: string
    method: 'pix' | 'card'
  }): Promise<{ subscriptionId: string; checkoutUrl?: string }>
  cancelSubscription(subscriptionId: string): Promise<void>
  /** Map a provider webhook request to a normalized event (or null to ignore). */
  parseWebhook(req: Request): Promise<BillingWebhookEvent | null>
}

export type BillingWebhookEvent =
  | { type: 'subscription_active'; gatewaySubscriptionId: string; periodEnd: string }
  | { type: 'subscription_past_due'; gatewaySubscriptionId: string }
  | { type: 'subscription_canceled'; gatewaySubscriptionId: string }
