import { NextResponse } from 'next/server'

export type BillingErrorCode =
  | 'billing_blocked'
  | 'plan_limit_reached'
  | 'ai_quota_exceeded'
  | 'contact_limit_reached'
  | 'channel_limit_reached'

const STATUS: Record<BillingErrorCode, number> = {
  billing_blocked: 402,
  ai_quota_exceeded: 402,
  plan_limit_reached: 403,
  contact_limit_reached: 403,
  channel_limit_reached: 403,
}

const MESSAGES: Record<BillingErrorCode, string> = {
  billing_blocked: 'Sua conta está bloqueada — assine um plano para voltar a disparar.',
  plan_limit_reached: 'Limite do seu plano atingido. Faça upgrade para continuar.',
  ai_quota_exceeded: 'Cota de mensagens de IA do plano esgotada neste ciclo. Faça upgrade.',
  contact_limit_reached: 'Limite de contatos do plano atingido. Faça upgrade para adicionar mais.',
  channel_limit_reached: 'Limite de números do plano atingido. Faça upgrade para conectar mais.',
}

export class BillingError extends Error {
  constructor(public code: BillingErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'BillingError'
  }
}

/** Standard billing error response: 402 for blocked/quota, 403 for caps. */
export function billingErrorResponse(code: BillingErrorCode, message?: string): NextResponse {
  return NextResponse.json(
    { error: { code, message: message ?? MESSAGES[code] } },
    { status: STATUS[code] },
  )
}

const PG_CODES: BillingErrorCode[] = [
  'billing_blocked',
  'ai_quota_exceeded',
  'contact_limit_reached',
  'channel_limit_reached',
  'plan_limit_reached',
]

/** Map a Postgres RAISE message to a billing code (or null if unrelated). */
export function mapPgBillingError(err: unknown): BillingErrorCode | null {
  const message =
    err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : ''
  return PG_CODES.find((c) => message.includes(c)) ?? null
}
