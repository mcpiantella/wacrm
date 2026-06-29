import type { BillingGateway } from './types'
import { stubGateway } from './stub'

/**
 * Gateway factory. Cycle A always returns the stub; Cycle B switches on
 * `process.env.BILLING_GATEWAY === 'asaas'` to return the real adapter.
 */
export function getGateway(): BillingGateway {
  return stubGateway
}

export type { BillingGateway, BillingWebhookEvent } from './types'
