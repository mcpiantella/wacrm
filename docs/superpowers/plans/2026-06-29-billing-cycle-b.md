# Billing Cycle B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the placeholder "Assinar" button into a working Asaas hosted-checkout (recurring credit card) flow, with webhook-driven subscription lifecycle and plan-gated AI model selection.

**Architecture:** A real Asaas adapter replaces the Cycle-A stub behind the `BillingGateway` interface (now checkout-first). A started checkout lives in its own `billing_checkouts` table and never mutates the live subscription — only a confirmed webhook does. Webhooks are idempotent via a processed-event table. The allowed AI model set is derived from the account's plan (capability keys → concrete models via a registry) and enforced server-side.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS, migrations via Supabase MCP `apply_migration`), Vitest (mocked `fetch`/supabase), Asaas REST API.

> **Verify the live Asaas API** (base URLs, endpoint paths, payload/response shapes, event names) against current Asaas docs before hard-coding any request body. The spec snippets are the intended flow, not a frozen contract. See `docs/superpowers/specs/2026-06-29-billing-cycle-b-design.md`.

---

## File Structure

- `supabase/migrations/033_billing_checkout.sql` — **create**: plan columns, `billing_checkouts`, `billing_webhook_events`.
- `src/lib/ai/model-registry.ts` — **create**: `MODEL_REGISTRY`, `resolveAllowedModels()`.
- `src/lib/ai/model-registry.test.ts` — **create**.
- `src/lib/billing/errors.ts` — **modify**: add `gateway_error`, `model_not_allowed` codes.
- `src/lib/billing/gateway/types.ts` — **modify**: checkout-first interface + expanded webhook events.
- `src/lib/billing/gateway/stub.ts` — **modify**: implement new interface.
- `src/lib/billing/gateway/asaas.ts` — **create**: real adapter.
- `src/lib/billing/gateway/asaas.test.ts` — **create**.
- `src/lib/billing/gateway/index.ts` — **modify**: env switch.
- `src/lib/billing/allowed-models.ts` — **create**: `assertModelAllowed()` helper + `getPlanAllowedModels()`.
- `src/lib/billing/allowed-models.test.ts` — **create**.
- `src/app/api/sdr/config/route.ts` — **modify**: enforce allow-list before persisting `model`.
- `src/lib/billing/checkout.ts` — **create**: `startCheckout()` (idempotency + billing_checkouts insert).
- `src/lib/billing/checkout.test.ts` — **create**.
- `src/app/api/billing/checkout/route.ts` — **create**: POST handler.
- `src/lib/billing/webhook-apply.ts` — **create**: pure `applyWebhookEvent()` status-transition mapper.
- `src/lib/billing/webhook-apply.test.ts` — **create**.
- `src/app/api/billing/webhook/route.ts` — **create**: POST handler (token + idempotency + apply).
- `src/components/settings/billing-settings.tsx` — **modify**: plan picker + checkout redirect.

---

## Task 1: Migration 033 — plan columns + checkout/event tables

**Files:**
- Create: `supabase/migrations/033_billing_checkout.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 033_billing_checkout.sql — Billing Cycle B.
-- Plan price + model capability keys; pending-checkout table;
-- webhook idempotency table.
-- ============================================================

-- ---- plans: price + model capability keys + custom flag ----
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS price_cents        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowed_model_keys TEXT[]  NOT NULL DEFAULT ARRAY['budget_default'],
  ADD COLUMN IF NOT EXISTS is_custom          BOOLEAN NOT NULL DEFAULT false;

UPDATE plans SET price_cents = 9700  WHERE id = 'starter';
UPDATE plans SET price_cents = 29700 WHERE id = 'pro';
UPDATE plans SET price_cents = 69700 WHERE id = 'business';

-- ---- billing_checkouts: a started checkout never mutates subscriptions ----
CREATE TABLE IF NOT EXISTS billing_checkouts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_plan_id          TEXT NOT NULL REFERENCES plans(id),
  gateway                 TEXT NOT NULL,
  gateway_checkout_id     TEXT,
  gateway_subscription_id TEXT,
  status                  TEXT NOT NULL DEFAULT 'started'
                            CHECK (status IN ('started','completed','expired','failed')),
  checkout_url            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_billing_checkouts_lookup
  ON billing_checkouts (account_id, target_plan_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_checkouts_gw
  ON billing_checkouts (gateway_checkout_id);

ALTER TABLE billing_checkouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_checkouts_select ON billing_checkouts;
CREATE POLICY billing_checkouts_select ON billing_checkouts
  FOR SELECT TO authenticated USING (is_account_member(account_id));
-- writes are service-role only (checkout + webhook routes); no INSERT/UPDATE policy.

-- ---- billing_webhook_events: real idempotency on provider event id ----
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id    TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
-- no policies: service-role only.
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with the Supabase MCP `apply_migration` tool (project `raqfuattunokpbozdhkc`, name `033_billing_checkout`). Use the file contents above.

- [ ] **Step 3: Verify**

Run these via the Supabase MCP `execute_sql` tool and confirm:
```sql
SELECT id, price_cents, allowed_model_keys, is_custom FROM plans ORDER BY sort;
-- expect: trial 0 / starter 9700 / pro 29700 / business 69700, all {budget_default}, is_custom=false
SELECT to_regclass('public.billing_checkouts'), to_regclass('public.billing_webhook_events');
-- expect: both non-null
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/033_billing_checkout.sql
git commit -m "feat(billing): migration 033 — plan price/model keys, checkout + webhook-event tables"
```

---

## Task 2: Model registry (pure)

**Files:**
- Create: `src/lib/ai/model-registry.ts`
- Test: `src/lib/ai/model-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { MODEL_REGISTRY, resolveAllowedModels } from './model-registry'

describe('model-registry', () => {
  it('budget_default resolves to the mini default', () => {
    expect(resolveAllowedModels(['budget_default'])).toContain('gpt-5.4-mini')
  })
  it('resolves multiple keys, deduped', () => {
    const models = resolveAllowedModels(['budget_default', 'openai_4o_mini', 'budget_default'])
    expect(models).toEqual(expect.arrayContaining(['gpt-5.4-mini', 'gpt-4o-mini']))
    expect(new Set(models).size).toBe(models.length)
  })
  it('ignores unknown keys', () => {
    expect(resolveAllowedModels(['nope'])).toEqual([])
  })
  it('every registry entry has provider + model', () => {
    for (const v of Object.values(MODEL_REGISTRY)) {
      expect(v.provider).toMatch(/openai|anthropic/)
      expect(typeof v.model).toBe('string')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/model-registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// Maps a plan's capability keys to concrete provider models. Plans store
// keys (not raw model strings) so provider/model churn never needs a data
// migration. Premium keys are only ever attached to custom/enterprise plans.
export const MODEL_REGISTRY = {
  budget_default:    { provider: 'openai',    model: 'gpt-5.4-mini' },
  openai_4o_mini:    { provider: 'openai',    model: 'gpt-4o-mini' },
  anthropic_haiku:   { provider: 'anthropic', model: 'claude-haiku-4-5' },
  premium_anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
} as const

export type ModelKey = keyof typeof MODEL_REGISTRY

/** Concrete model strings the given capability keys resolve to (deduped). */
export function resolveAllowedModels(keys: string[]): string[] {
  const out = new Set<string>()
  for (const k of keys) {
    const entry = (MODEL_REGISTRY as Record<string, { model: string }>)[k]
    if (entry) out.add(entry.model)
  }
  return [...out]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/model-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/model-registry.ts src/lib/ai/model-registry.test.ts
git commit -m "feat(billing): model registry — capability keys -> concrete models"
```

---

## Task 3: Add `gateway_error` + `model_not_allowed` error codes

**Files:**
- Modify: `src/lib/billing/errors.ts`

- [ ] **Step 1: Add the two codes to the union**

In `src/lib/billing/errors.ts`, extend `BillingErrorCode`:

```ts
export type BillingErrorCode =
  | 'billing_blocked'
  | 'plan_limit_reached'
  | 'ai_quota_exceeded'
  | 'contact_limit_reached'
  | 'channel_limit_reached'
  | 'gateway_error'
  | 'model_not_allowed'
```

- [ ] **Step 2: Add their STATUS + MESSAGES entries**

Add to the `STATUS` record:
```ts
  gateway_error: 502,
  model_not_allowed: 400,
```
Add to the `MESSAGES` record:
```ts
  gateway_error: 'Falha ao comunicar com o gateway de pagamento. Tente novamente.',
  model_not_allowed: 'O modelo de IA selecionado não está disponível no seu plano.',
```

> Do NOT add these to `PG_CODES` — they are not raised by Postgres triggers.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the `Record<BillingErrorCode, ...>` maps now require — and have — all 7 keys).

- [ ] **Step 4: Commit**

```bash
git add src/lib/billing/errors.ts
git commit -m "feat(billing): add gateway_error + model_not_allowed error codes"
```

---

## Task 4: Checkout-first gateway interface + stub update

**Files:**
- Modify: `src/lib/billing/gateway/types.ts`
- Modify: `src/lib/billing/gateway/stub.ts`

- [ ] **Step 1: Rewrite the interface**

Replace the contents of `src/lib/billing/gateway/types.ts` with:

```ts
export interface CreateCheckoutInput {
  accountId: string
  planId: string
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
```

- [ ] **Step 2: Update the stub to match**

Replace the contents of `src/lib/billing/gateway/stub.ts` with:

```ts
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
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `gateway/asaas.ts` (does not exist yet) and any old call sites — confirm there are no other consumers of the removed `createCustomer`/`createSubscription`. Run:
`grep -rn "createSubscription\|createCustomer" src/` → expect only matches inside specs/this plan, none in app code. If any app code matched, it must be updated to `createCheckout` (none expected — Cycle A never called them).

- [ ] **Step 4: Commit**

```bash
git add src/lib/billing/gateway/types.ts src/lib/billing/gateway/stub.ts
git commit -m "refactor(billing): checkout-first gateway interface + stub"
```

---

## Task 5: Asaas adapter

**Files:**
- Create: `src/lib/billing/gateway/asaas.ts`
- Test: `src/lib/billing/gateway/asaas.test.ts`

- [ ] **Step 1: Write the failing test (mocked fetch + webhook mapping)**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { asaasGateway } from './asaas'

const ENV = { ASAAS_BASE_URL: 'https://api-sandbox.asaas.com/v3', ASAAS_API_KEY: 'k', ASAAS_WEBHOOK_TOKEN: 'tok' }
beforeEach(() => { Object.assign(process.env, ENV); vi.restoreAllMocks() })

function webhookReq(body: unknown, token = 'tok') {
  return new Request('https://x/api/billing/webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('asaasGateway.createCheckout', () => {
  it('POSTs a recurrent credit-card checkout and returns the hosted url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'chk_1', link: 'https://asaas/checkout/chk_1' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await asaasGateway.createCheckout({
      accountId: 'acc-1', planId: 'pro', value: 297, cycle: 'MONTHLY',
      successUrl: 's', cancelUrl: 'c', expiredUrl: 'e', customer: { name: 'Acme' },
    })
    expect(res.checkoutId).toBe('chk_1')
    expect(res.checkoutUrl).toContain('chk_1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api-sandbox.asaas.com/v3/checkouts')
    expect((init.headers as Record<string, string>)['access_token']).toBe('k')
    const sent = JSON.parse(init.body as string)
    expect(sent.billingTypes).toEqual(['CREDIT_CARD'])
    expect(sent.chargeTypes).toEqual(['RECURRENT'])
    expect(sent.subscription.cycle).toBe('MONTHLY')
    expect(sent.externalReference).toBe('acc-1')
  })
  it('maps a 4xx into a BillingError(gateway_error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ errors: [] }) }))
    await expect(asaasGateway.createCheckout({
      accountId: 'a', planId: 'pro', value: 1, cycle: 'MONTHLY', successUrl: 's', cancelUrl: 'c', expiredUrl: 'e',
    })).rejects.toMatchObject({ code: 'gateway_error' })
  })
})

describe('asaasGateway.parseWebhook', () => {
  it('rejects a bad token', async () => {
    expect(await asaasGateway.parseWebhook(webhookReq({ event: 'PAYMENT_CONFIRMED' }, 'WRONG'))).toBeNull()
  })
  it('PAYMENT_CONFIRMED -> subscription_active', async () => {
    const ev = await asaasGateway.parseWebhook(webhookReq({
      event: 'PAYMENT_CONFIRMED',
      payment: { subscription: 'sub_1', dueDate: '2026-07-29', externalReference: 'acc-1' },
    }))
    expect(ev).toMatchObject({ type: 'subscription_active', gatewaySubscriptionId: 'sub_1' })
  })
  it.each([
    ['PAYMENT_OVERDUE', 'subscription_past_due'],
    ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'subscription_past_due'],
    ['PAYMENT_CHARGEBACK_REQUESTED', 'subscription_past_due'],
    ['PAYMENT_CHARGEBACK_DISPUTE', 'subscription_past_due'],
    ['PAYMENT_REFUNDED', 'subscription_canceled'],
    ['PAYMENT_DELETED', 'subscription_canceled'],
    ['SUBSCRIPTION_DELETED', 'subscription_canceled'],
  ])('%s -> %s', async (event, type) => {
    const ev = await asaasGateway.parseWebhook(webhookReq({ event, payment: { subscription: 'sub_1' } }))
    expect(ev?.type).toBe(type)
  })
  it('ignores unknown events', async () => {
    expect(await asaasGateway.parseWebhook(webhookReq({ event: 'PAYMENT_PARTIALLY_REFUNDED' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/billing/gateway/asaas.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the adapter**

```ts
import { BillingError } from '../errors'
import type { BillingGateway, BillingWebhookEvent, CreateCheckoutInput } from './types'

function baseUrl() { return process.env.ASAAS_BASE_URL ?? 'https://api-sandbox.asaas.com/v3' }
function headers() {
  return {
    'content-type': 'application/json',
    'access_token': process.env.ASAAS_API_KEY ?? '',
    'User-Agent': `ZenithSender/${process.env.npm_package_version ?? '0'} (${process.env.NODE_ENV ?? 'dev'})`,
  }
}

async function asaasFetch(path: string, init: RequestInit) {
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
  } catch {
    throw new BillingError('gateway_error', 'Asaas request failed')
  }
  if (!res.ok) throw new BillingError('gateway_error', `Asaas ${res.status}`)
  return res.json()
}

// NOTE: verify exact /checkouts path + field names against live Asaas docs.
const PAST_DUE = new Set(['PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'])
const CANCELED = new Set(['PAYMENT_REFUNDED', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED'])
const ACTIVE = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])

export const asaasGateway: BillingGateway = {
  async createCheckout(input: CreateCheckoutInput) {
    const body = {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      subscription: { cycle: input.cycle },
      value: input.value,
      externalReference: input.accountId,
      callback: { successUrl: input.successUrl, cancelUrl: input.cancelUrl, expiredUrl: input.expiredUrl },
      ...(input.customer ? { customerData: { name: input.customer.name, email: input.customer.email } } : {}),
    }
    const json = await asaasFetch('/checkouts', { method: 'POST', body: JSON.stringify(body) })
    return {
      checkoutId: String(json.id),
      checkoutUrl: String(json.link ?? json.url ?? json.checkoutUrl),
      gatewayCustomerId: json.customer ? String(json.customer) : undefined,
    }
  },

  async cancelSubscription(subscriptionId) {
    await asaasFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' })
  },

  async parseWebhook(req) {
    const token = req.headers.get('asaas-access-token') ?? ''
    const expected = process.env.ASAAS_WEBHOOK_TOKEN ?? ''
    if (!timingSafeEqual(token, expected)) return null
    const body = (await req.json().catch(() => null)) as { event?: string; payment?: Record<string, unknown> } | null
    if (!body?.event) return null
    const sub = body.payment?.subscription ? String(body.payment.subscription) : undefined
    const periodEnd = body.payment?.dueDate ? String(body.payment.dueDate) : new Date().toISOString()
    if (ACTIVE.has(body.event)) return { type: 'subscription_active', gatewaySubscriptionId: sub, periodEnd }
    if (PAST_DUE.has(body.event)) return { type: 'subscription_past_due', gatewaySubscriptionId: sub }
    if (CANCELED.has(body.event)) return { type: 'subscription_canceled', gatewaySubscriptionId: sub }
    return null
  },
}

/** Constant-time string compare (avoids leaking via early return). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/billing/gateway/asaas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/billing/gateway/asaas.ts src/lib/billing/gateway/asaas.test.ts
git commit -m "feat(billing): Asaas adapter — recurring checkout + webhook mapping"
```

---

## Task 6: Gateway factory env switch

**Files:**
- Modify: `src/lib/billing/gateway/index.ts`

- [ ] **Step 1: Update the factory**

Replace the contents of `src/lib/billing/gateway/index.ts` with:

```ts
import type { BillingGateway } from './types'
import { stubGateway } from './stub'
import { asaasGateway } from './asaas'

/** Stub by default (CI/local stay offline); Asaas when BILLING_GATEWAY=asaas. */
export function getGateway(): BillingGateway {
  return process.env.BILLING_GATEWAY === 'asaas' ? asaasGateway : stubGateway
}

export type { BillingGateway, BillingWebhookEvent, CreateCheckoutInput } from './types'
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/billing/gateway/index.ts
git commit -m "feat(billing): gateway factory switches to Asaas via BILLING_GATEWAY env"
```

---

## Task 7: Plan allowed-models helper + SDR config enforcement

**Files:**
- Create: `src/lib/billing/allowed-models.ts`
- Test: `src/lib/billing/allowed-models.test.ts`
- Modify: `src/app/api/sdr/config/route.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { assertModelAllowed } from './allowed-models'

// minimal supabase stub: one plan lookup chain returning allowed_model_keys
function db(keys: string[] | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: keys ? { allowed_model_keys: keys } : null, error: null }),
        }),
      }),
    }),
  } as never
}

describe('assertModelAllowed', () => {
  it('passes when model is null (worker default)', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', null)).resolves.toBeUndefined()
  })
  it('passes when model is in the plan resolved set', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', 'gpt-5.4-mini')).resolves.toBeUndefined()
  })
  it('throws model_not_allowed for a model outside the plan', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', 'claude-sonnet-4-6'))
      .rejects.toMatchObject({ code: 'model_not_allowed' })
  })
  it('passes premium model on a plan whose keys include it', async () => {
    await expect(assertModelAllowed(db(['budget_default', 'premium_anthropic']), 'acc', 'claude-sonnet-4-6'))
      .resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/billing/allowed-models.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the helper**

```ts
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
```

> The test stub only mocks the `plans` lookup; `getPlanAllowedModels` calls `subscriptions` first. Adjust the test's `db()` to return `{ plan_id: 'x' }` for the first `from()` and `{ allowed_model_keys }` for the second. Implement `db()` as a counter that returns the subscription row on call 1 and the plan row on call 2:

```ts
function db(keys: string[] | null) {
  let call = 0
  const chain = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) })
  return { from: () => { call++; return call === 1 ? chain({ plan_id: 'p' }) : chain(keys ? { allowed_model_keys: keys } : null) } } as never
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/billing/allowed-models.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Enforce in the SDR config route**

In `src/app/api/sdr/config/route.ts`, locate the POST handler where `model` is computed (`model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null`). Add, before building `row`:

```ts
import { assertModelAllowed } from '@/lib/billing/allowed-models'
import { BillingError, billingErrorResponse } from '@/lib/billing/errors'
```
and immediately before the `const row = {` line:
```ts
    const requestedModel = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null
    try {
      await assertModelAllowed(supabase, accountId, requestedModel)
    } catch (e) {
      if (e instanceof BillingError) return billingErrorResponse(e.code)
      throw e
    }
```
then change the `row`'s `model` field to use `requestedModel`:
```ts
      model: requestedModel,
```

(`supabase` and `accountId` are already in scope in this handler — confirm by reading the handler top; if the client variable has a different name, use it.)

- [ ] **Step 6: Typecheck + full billing tests**

Run: `npx tsc --noEmit && npx vitest run src/lib/billing src/lib/ai/model-registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing/allowed-models.ts src/lib/billing/allowed-models.test.ts "src/app/api/sdr/config/route.ts"
git commit -m "feat(billing): plan-gated AI model allow-list enforced in SDR config route"
```

---

## Task 8: Checkout service (idempotency + billing_checkouts)

**Files:**
- Create: `src/lib/billing/checkout.ts`
- Test: `src/lib/billing/checkout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { startCheckout } from './checkout'

// Build a supabase-like stub. Tracks inserts; returns a configurable existing row.
function makeDb(existing: { checkout_url: string } | null) {
  const inserts: unknown[] = []
  const db = {
    inserts,
    from(table: string) {
      if (table === 'plans') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'pro', price_cents: 29700, is_custom: false }, error: null }) }) }),
      }
      if (table === 'subscriptions') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { gateway_customer_id: null }, error: null }) }) }),
      }
      if (table === 'billing_checkouts') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }) }) }) }) }) }) }),
        insert: (row: unknown) => { inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'chk-row' }, error: null }) }) } },
      }
      throw new Error('unexpected table ' + table)
    },
  }
  return db as never
}

const gateway = { createCheckout: vi.fn().mockResolvedValue({ checkoutId: 'chk_1', checkoutUrl: 'https://pay/chk_1' }), cancelSubscription: vi.fn(), parseWebhook: vi.fn() }

describe('startCheckout', () => {
  it('reuses a recent started checkout instead of calling the gateway', async () => {
    const db = makeDb({ checkout_url: 'https://pay/existing' })
    const res = await startCheckout({ db, gateway, accountId: 'acc-1', planId: 'pro', origin: 'https://app' })
    expect(res.checkoutUrl).toBe('https://pay/existing')
    expect(gateway.createCheckout).not.toHaveBeenCalled()
  })
  it('creates a new checkout and persists a billing_checkouts row', async () => {
    const db = makeDb(null)
    const res = await startCheckout({ db, gateway, accountId: 'acc-1', planId: 'pro', origin: 'https://app' })
    expect(res.checkoutUrl).toBe('https://pay/chk_1')
    expect(gateway.createCheckout).toHaveBeenCalledOnce()
    expect((db as unknown as { inserts: { gateway_checkout_id?: string }[] }).inserts[0].gateway_checkout_id).toBe('chk_1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/billing/checkout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the service**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BillingGateway } from './gateway/types'
import { BillingError } from './errors'

const IDEMPOTENCY_MINUTES = 30

interface StartCheckoutArgs {
  db: SupabaseClient
  gateway: BillingGateway
  accountId: string
  planId: string
  origin: string // e.g. https://app.host — used to build callback URLs
}

/** Start a hosted recurring checkout. Never mutates `subscriptions`. */
export async function startCheckout(args: StartCheckoutArgs): Promise<{ checkoutUrl: string }> {
  const { db, gateway, accountId, planId, origin } = args

  const { data: plan } = await db
    .from('plans').select('id, price_cents, is_custom').eq('id', planId).maybeSingle()
  const p = plan as { id: string; price_cents: number; is_custom: boolean } | null
  if (!p || p.is_custom || p.price_cents <= 0) throw new BillingError('plan_limit_reached', 'Plano inválido para checkout.')

  // Idempotency: reuse a recent started checkout for the same account+plan.
  const since = new Date(Date.now() - IDEMPOTENCY_MINUTES * 60_000).toISOString()
  const { data: existing } = await db
    .from('billing_checkouts')
    .select('checkout_url').eq('account_id', accountId).eq('target_plan_id', planId).eq('status', 'started')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing && (existing as { checkout_url?: string }).checkout_url) {
    return { checkoutUrl: (existing as { checkout_url: string }).checkout_url }
  }

  const { data: sub } = await db
    .from('subscriptions').select('gateway_customer_id').eq('account_id', accountId).maybeSingle()
  const customerId = (sub as { gateway_customer_id?: string } | null)?.gateway_customer_id ?? undefined

  const back = `${origin}/settings?tab=billing`
  const checkout = await gateway.createCheckout({
    accountId, planId, value: p.price_cents / 100, cycle: 'MONTHLY',
    successUrl: back, cancelUrl: back, expiredUrl: back,
    customer: { customerId, name: accountId }, // name refined in route from account
  })

  await db.from('billing_checkouts').insert({
    account_id: accountId, target_plan_id: planId, gateway: 'asaas',
    gateway_checkout_id: checkout.checkoutId, checkout_url: checkout.checkoutUrl, status: 'started',
  }).select('id').single()

  return { checkoutUrl: checkout.checkoutUrl }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/billing/checkout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/billing/checkout.ts src/lib/billing/checkout.test.ts
git commit -m "feat(billing): startCheckout service — idempotent, never mutates subscription"
```

---

## Task 9: Checkout API route

**Files:**
- Create: `src/app/api/billing/checkout/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getGateway } from '@/lib/billing/gateway'
import { startCheckout } from '@/lib/billing/checkout'
import { BillingError, billingErrorResponse } from '@/lib/billing/errors'

/** POST /api/billing/checkout { planId } -> { checkoutUrl } */
export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentAccount()
    const body = await request.json().catch(() => null)
    const planId = body && typeof body === 'object' ? (body as { planId?: unknown }).planId : undefined
    if (typeof planId !== 'string' || !planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 })
    }
    const origin = new URL(request.url).origin
    const { checkoutUrl } = await startCheckout({
      db: supabaseAdmin(), gateway: getGateway(), accountId, planId, origin,
    })
    return NextResponse.json({ checkoutUrl })
  } catch (err) {
    if (err instanceof BillingError) return billingErrorResponse(err.code)
    return toErrorResponse(err)
  }
}
```

> Confirm `getCurrentAccount` is exported from `@/lib/auth/account` (it is used by `src/app/api/channels/route.ts`). Service-role (`supabaseAdmin`) is used for the write because `billing_checkouts` has no INSERT policy; account scoping comes from the authenticated `accountId`.

- [ ] **Step 2: Typecheck + build the route**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/billing/checkout/route.ts"
git commit -m "feat(billing): POST /api/billing/checkout"
```

---

## Task 10: Webhook apply (pure transition) + route

**Files:**
- Create: `src/lib/billing/webhook-apply.ts`
- Test: `src/lib/billing/webhook-apply.test.ts`
- Create: `src/app/api/billing/webhook/route.ts`

- [ ] **Step 1: Write the failing test for the pure mapper**

```ts
import { describe, it, expect } from 'vitest'
import { subscriptionPatchForEvent } from './webhook-apply'

describe('subscriptionPatchForEvent', () => {
  it('active sets status + period + clears trial + plan', () => {
    const patch = subscriptionPatchForEvent({ type: 'subscription_active', periodEnd: '2026-07-29' }, 'pro')
    expect(patch).toMatchObject({ status: 'active', plan_id: 'pro', current_period_end: '2026-07-29', trial_ends_at: null })
  })
  it('past_due sets only status', () => {
    expect(subscriptionPatchForEvent({ type: 'subscription_past_due' }, 'pro')).toEqual({ status: 'past_due' })
  })
  it('canceled sets only status', () => {
    expect(subscriptionPatchForEvent({ type: 'subscription_canceled' }, 'pro')).toEqual({ status: 'canceled' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/billing/webhook-apply.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the pure mapper**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/billing/webhook-apply.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the webhook route**

```ts
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getGateway } from '@/lib/billing/gateway'
import { recordBillingEvent } from '@/lib/billing/events'
import { subscriptionPatchForEvent } from '@/lib/billing/webhook-apply'

/** POST /api/billing/webhook — Asaas events. Always 200 once token is valid. */
export async function POST(request: Request) {
  const gateway = getGateway()
  // Read body once for idempotency id, then re-create a Request for parseWebhook.
  const raw = await request.text()
  const headers = request.headers
  let eventId: string | null = null
  try { eventId = (JSON.parse(raw) as { id?: string }).id ?? null } catch { eventId = null }

  const db = supabaseAdmin()
  // Token check happens inside parseWebhook; build a fresh Request with the body.
  const ev = await gateway.parseWebhook(new Request(request.url, { method: 'POST', headers, body: raw }))
  if (!ev) return NextResponse.json({ ok: true }) // bad token or ignored event -> 200, no state change

  if (eventId) {
    const { error } = await db.from('billing_webhook_events').insert({ event_id: eventId })
    if (error) return NextResponse.json({ ok: true, duplicate: true }) // PK conflict => already processed
  }

  // Resolve the account + target plan via the started checkout (by subscription id).
  let accountId: string | null = null
  let targetPlanId: string | null = null
  if (ev.gatewaySubscriptionId || ev.gatewayCheckoutId) {
    const { data: chk } = await db
      .from('billing_checkouts')
      .select('account_id, target_plan_id, id')
      .or([
        ev.gatewaySubscriptionId ? `gateway_subscription_id.eq.${ev.gatewaySubscriptionId}` : '',
        ev.gatewayCheckoutId ? `gateway_checkout_id.eq.${ev.gatewayCheckoutId}` : '',
      ].filter(Boolean).join(','))
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    const row = chk as { account_id?: string; target_plan_id?: string; id?: string } | null
    if (row) {
      accountId = row.account_id ?? null
      targetPlanId = row.target_plan_id ?? null
      if (ev.type === 'subscription_active' && row.id) {
        await db.from('billing_checkouts').update({
          status: 'completed', completed_at: new Date().toISOString(),
          ...(ev.gatewaySubscriptionId ? { gateway_subscription_id: ev.gatewaySubscriptionId } : {}),
        }).eq('id', row.id)
      }
    }
  }
  // Fallback: match the subscription directly by gateway_subscription_id.
  if (!accountId && ev.gatewaySubscriptionId) {
    const { data: sub } = await db
      .from('subscriptions').select('account_id').eq('gateway_subscription_id', ev.gatewaySubscriptionId).maybeSingle()
    accountId = (sub as { account_id?: string } | null)?.account_id ?? null
  }
  if (!accountId) return NextResponse.json({ ok: true, unmatched: true })

  const patch = subscriptionPatchForEvent(ev, targetPlanId)
  await db.from('subscriptions').update({ ...patch, updated_at: new Date().toISOString() }).eq('account_id', accountId)
  await recordBillingEvent(db, accountId, 'subscription_status_changed', { event: ev.type })

  return NextResponse.json({ ok: true })
}
```

> `billing_events` type CHECK (migration 032) already includes `subscription_status_changed`. Confirm the `or(...)` filter syntax against the installed `@supabase/supabase-js` version; if `.or()` with interpolation is awkward, do two sequential `.eq()` lookups instead (subscription id first, then checkout id).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing/webhook-apply.ts src/lib/billing/webhook-apply.test.ts "src/app/api/billing/webhook/route.ts"
git commit -m "feat(billing): POST /api/billing/webhook — idempotent, upgrade-safe transitions"
```

---

## Task 11: Frontend — plan picker + checkout redirect

**Files:**
- Modify: `src/components/settings/billing-settings.tsx`

- [ ] **Step 1: Add plan fetch + picker + checkout handler**

In `src/components/settings/billing-settings.tsx`, replace the single placeholder button with a plan picker. Add near the other hooks:

```tsx
const [plans, setPlans] = useState<{ id: string; name: string; price_cents: number }[]>([]);
const [busy, setBusy] = useState<string | null>(null);

useEffect(() => {
  const supabase = createClient();
  void supabase
    .from('plans')
    .select('id, name, price_cents, is_custom, sort')
    .eq('is_custom', false)
    .gt('price_cents', 0)
    .order('sort')
    .then(({ data }) => setPlans((data as typeof plans) ?? []));
}, []);

async function subscribe(planId: string) {
  setBusy(planId);
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    const json = await res.json();
    if (!res.ok || !json.checkoutUrl) {
      toast.error(json?.error?.message ?? 'Falha ao iniciar o checkout.');
      return;
    }
    window.location.href = json.checkoutUrl;
  } finally {
    setBusy(null);
  }
}
```

- [ ] **Step 2: Replace the placeholder button with the picker UI**

Replace the existing `<Button onClick={() => toast.info('Checkout em breve.')}>...</Button>` with:

```tsx
<div className="grid gap-3 sm:grid-cols-3">
  {plans.map((pl) => (
    <div key={pl.id} className="border-border bg-card flex flex-col gap-2 rounded-xl border p-4">
      <div className="text-sm font-semibold text-foreground">{pl.name}</div>
      <div className="text-2xl font-bold text-foreground">
        R$ {(pl.price_cents / 100).toLocaleString('pt-BR')}
        <span className="text-xs font-normal text-muted-foreground">/mês</span>
      </div>
      <Button
        className="mt-2"
        disabled={busy !== null || pl.id === v.plan.id}
        onClick={() => subscribe(pl.id)}
      >
        {pl.id === v.plan.id ? 'Plano atual' : busy === pl.id ? 'Abrindo…' : 'Assinar'}
      </Button>
    </div>
  ))}
</div>
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/settings/billing-settings.tsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/billing-settings.tsx
git commit -m "feat(billing): plan picker + Asaas checkout redirect in billing settings"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all billing/registry tests pass. (Pre-existing `src/lib/dashboard/date-utils.test.ts` timezone failures are unrelated and may remain — do NOT fix them in this plan.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint the changed files**

Run: `npx eslint src/lib/billing src/lib/ai/model-registry.ts "src/app/api/billing" "src/app/api/sdr/config/route.ts" src/components/settings/billing-settings.tsx`
Expected: 0 errors (pre-existing warnings elsewhere are fine).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: "Compiled successfully" + "Finished TypeScript". (A prerender step may fail locally without Supabase env vars — that is an environment limitation, not a code failure, as long as TypeScript finished.)

- [ ] **Step 5: Push**

```bash
git push origin HEAD
```

- [ ] **Step 6: Post-merge ops checklist (manual, not code)**

Document for the operator (do not execute here):
1. Create Asaas **sandbox** account; set `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` on `zenith-sender`.
2. Register the webhook URL `https://<web-host>/api/billing/webhook` in Asaas with the matching access token.
3. Leave `BILLING_GATEWAY` unset until the sandbox checklist passes; then set `BILLING_GATEWAY=asaas`.
4. Sandbox checklist: subscribe with an Asaas test card → confirm `subscription_active`; force a refund and a chargeback → confirm `past_due`/`canceled`; click "Assinar" twice fast → confirm a single checkout row.
5. Verify the exact `/checkouts` payload + event field names against live Asaas docs before flipping prod.
```

