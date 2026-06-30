import type { BillingGateway } from './types'
import { stubGateway } from './stub'
import { asaasGateway } from './asaas'

/** Stub by default (CI/local stay offline); Asaas when BILLING_GATEWAY=asaas. */
export function getGateway(): BillingGateway {
  return process.env.BILLING_GATEWAY === 'asaas' ? asaasGateway : stubGateway
}

export type { BillingGateway, BillingWebhookEvent, CreateCheckoutInput } from './types'
