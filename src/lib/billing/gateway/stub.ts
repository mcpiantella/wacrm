import type { BillingGateway } from './types'

/**
 * Cycle-A no-op gateway: deterministic ids, no external calls. Used in CI and
 * local dev (BILLING_GATEWAY unset). The real Asaas adapter is gateway/asaas.ts.
 */
export const stubGateway: BillingGateway = {
  async createCheckout({ accountId, planId }) {
    return {
      checkoutId: `stub_chk_${accountId}_${planId}`,
      checkoutUrl: `https://example.invalid/checkout/${accountId}/${planId}`,
      gatewayCustomerId: `stub_cus_${accountId}`,
    }
  },
  async cancelSubscription() {
    /* no-op */
  },
  async parseWebhook() {
    return null
  },
}
