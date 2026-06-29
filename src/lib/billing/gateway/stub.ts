import type { BillingGateway } from './types'

/**
 * Cycle-A no-op gateway: deterministic ids, no external calls. The real Asaas
 * implementation (Pix Automático + card) is Cycle B and plugs into this same
 * interface.
 */
export const stubGateway: BillingGateway = {
  async createCustomer({ accountId }) {
    return { customerId: `stub_cus_${accountId}` }
  },
  async createSubscription({ customerId, planId }) {
    return { subscriptionId: `stub_sub_${customerId}_${planId}`, checkoutUrl: undefined }
  },
  async cancelSubscription() {
    /* no-op */
  },
  async parseWebhook() {
    return null
  },
}
