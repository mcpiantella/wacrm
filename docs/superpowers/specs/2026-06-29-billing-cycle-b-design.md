# Billing — Cycle B (Asaas, real checkout) — Design

**Date:** 2026-06-29
**Status:** revised after adversarial review, pending final spec review
**Depends on:** Cycle A (migration 032, `BillingGateway` interface, entitlements, gating). Cycle B replaces the stub gateway with a real Asaas adapter and turns the placeholder "Assinar" button into a working hosted checkout.

> **Implementation note — verify the live API.** Exact Asaas request/response shapes, endpoint paths, base URLs, and event names below reflect the cited docs as of 2026-06; they MUST be re-verified against the live Asaas documentation during implementation (per the research-first workflow) before any request payload is hard-coded. Treat the snippets here as the intended **flow**, not a frozen contract.

---

## 1. Decisions (locked in brainstorm + review)

| Topic | Decision |
|---|---|
| Payment method | **Credit card only** — recurring, hands-off; webhooks drive the lifecycle. |
| Card collection | **Asaas Checkout (recurring)** — hosted page collects the card and, on completion, Asaas creates the subscription with automatic monthly charges. We never touch card data (no PCI surface). |
| Prices (standard plans) | Starter **R$97** · Pro **R$297** · Business **R$697** /month. Trial = free. |
| AI model exposure | Allowed models derived from the **account's plan** (via capability keys), validated server-side. Tenants can never select a model outside their plan — including via direct API calls. |
| Standard plan models | Budget tier only (`budget_default` key → `gpt-5.4-mini`, plus `gpt-4o-mini`, `claude-haiku-4-5`). |
| Premium models | Only via **custom/enterprise plans** the operator attaches (expanded `allowed_model_keys`). Not self-serve; priced to cover cost. |

**Out of scope (Cycle B):** dunning emails, mid-cycle proration, invoices UI, multiple concurrent subscriptions, PIX/boleto, self-serve enterprise checkout.

---

## 2. Why not `POST /subscriptions` directly

The first draft created an Asaas subscription via `POST /v3/subscriptions` with `billingType: CREDIT_CARD` and surfaced the "first invoiceUrl" as the checkout link. That is wrong for a hosted-checkout product:

- Asaas's subscription API is a **billing scheduler**: the first charge is created *after* the subscription, reachable only via `GET /v3/subscriptions/{id}/payments` — there is no reliable `checkoutUrl` returned synchronously.
- The card-subscription endpoint expects **card/holder/token + remoteIp** at creation time — i.e. it validates the card during the call, which defeats "we never touch card data."

Correct primitive: **Asaas Checkout with `chargeTypes:["RECURRENT"]` + `subscription.cycle: MONTHLY`**. The hosted checkout collects the card; on completion Asaas creates the subscription and emits webhooks. (Recurring Payment Link is an alternative but less "SaaS-checkout"; we choose Checkout.)

---

## 3. Data model changes (migration 033)

### 3.1 Extend `plans`

```sql
ALTER TABLE plans
  ADD COLUMN price_cents       INTEGER NOT NULL DEFAULT 0,                 -- monthly, BRL cents
  ADD COLUMN allowed_model_keys TEXT[] NOT NULL DEFAULT ARRAY['budget_default'],
  ADD COLUMN is_custom         BOOLEAN NOT NULL DEFAULT false;             -- enterprise; hidden from self-serve

UPDATE plans SET price_cents = 9700  WHERE id = 'starter';
UPDATE plans SET price_cents = 29700 WHERE id = 'pro';
UPDATE plans SET price_cents = 69700 WHERE id = 'business';
-- trial stays price_cents = 0, allowed_model_keys = {budget_default}
```

Plans reference **capability keys**, not raw provider model strings, so model churn / provider deprecation never requires a data migration. A custom plan (e.g. `id='enterprise_acme'`, `is_custom=true`, `allowed_model_keys = '{budget_default,premium_anthropic}'`, bespoke `price_cents`) is created by the operator and assigned via `subscriptions.plan_id`.

### 3.2 New table `billing_checkouts` (pending checkouts)

A started checkout must **never** mutate the live subscription — otherwise a failed/abandoned upgrade downgrades a paying customer. The pending intent lives in its own table; the subscription only changes when a webhook confirms payment.

```sql
CREATE TABLE billing_checkouts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_plan_id          TEXT NOT NULL REFERENCES plans(id),
  gateway                 TEXT NOT NULL,
  gateway_checkout_id     TEXT,
  gateway_subscription_id TEXT,                     -- filled when the webhook links the subscription
  status                  TEXT NOT NULL DEFAULT 'started'
                            CHECK (status IN ('started','completed','expired','failed')),
  checkout_url            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);
CREATE INDEX idx_billing_checkouts_account ON billing_checkouts (account_id, target_plan_id, status, created_at DESC);
```

RLS: members read their own account's rows; writes are service-role (checkout + webhook routes).

### 3.3 Processed webhook events (idempotency)

Real idempotency keyed on the provider event id, not "duplicates are harmless":

```sql
CREATE TABLE billing_webhook_events (
  event_id     TEXT PRIMARY KEY,        -- Asaas event/payment id
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The webhook handler inserts `event_id` first; a conflict ⇒ already processed ⇒ ack `200` and stop.

`subscriptions` keeps its Cycle-A `gateway`, `gateway_customer_id`, `gateway_subscription_id` columns. No per-subscription model column — the allow-list is read from the plan.

---

## 4. Model registry (`src/lib/ai/model-registry.ts`)

```ts
export const MODEL_REGISTRY = {
  budget_default:    { provider: 'openai',    model: 'gpt-5.4-mini' },
  openai_4o_mini:    { provider: 'openai',    model: 'gpt-4o-mini' },
  anthropic_haiku:   { provider: 'anthropic', model: 'claude-haiku-4-5' },
  // premium keys (custom plans only) — concrete models filled at implementation
  premium_anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
} as const;

/** Concrete model strings a plan's keys resolve to. */
export function resolveAllowedModels(keys: string[]): string[] { /* map via registry, dedupe */ }
```

The SDR config column stays a raw `model` string (no change to migration 029). Validation resolves the plan's keys to concrete models and checks membership — decoupling **plan capability** from **provider string**.

---

## 5. Gateway adapter (`src/lib/billing/gateway/asaas.ts`)

Interface change (`gateway/types.ts`): replace the subscription-returns-url shape with a checkout-first one.

```ts
createCheckout(input: {
  accountId: string; planId: string; value: number; cycle: 'MONTHLY';
  successUrl: string; cancelUrl: string; expiredUrl: string;
  customer?: { customerId?: string; name: string; email?: string };
}): Promise<{ checkoutId: string; checkoutUrl: string; gatewayCustomerId?: string }>
cancelSubscription(subscriptionId: string): Promise<void>
parseWebhook(req: Request): Promise<BillingWebhookEvent | null>
```

`subscriptionId` is **not** returned at checkout time; it arrives via the webhook once the customer completes payment.

- **Base URL / auth:** sandbox `https://api-sandbox.asaas.com/v3`, prod `https://api.asaas.com/v3`. API key in header `access_token` (not `Authorization: Bearer`). Always send `Content-Type: application/json` and `User-Agent: ZenithSender/<version> (<env>)`.
- **createCheckout** → `POST /checkouts` (verify path) with `billingTypes:['CREDIT_CARD']`, `chargeTypes:['RECURRENT']`, `subscription:{cycle:'MONTHLY'}`, `value`, `externalReference = account_id`, and the success/cancel/expired callback URLs pointing at `/settings?tab=billing`. Returns the hosted `checkoutUrl`.
- **parseWebhook** → verify the `asaas-access-token` header (constant-time) against `ASAAS_WEBHOOK_TOKEN`; parse and map (table below); return `null` for ignored events.

`getGateway()` returns the Asaas adapter when `BILLING_GATEWAY === 'asaas'`, else the stub (CI/local stay offline).

### Webhook → normalized status

| Asaas event | Action |
|---|---|
| `PAYMENT_CONFIRMED` | `active` (activate here — don't wait for funds settlement) |
| `PAYMENT_RECEIVED` | `active` (idempotent; no-op if already active) |
| `PAYMENT_OVERDUE` | `past_due` |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` | `past_due` |
| `PAYMENT_REFUNDED` | `canceled` (full refund ends the period) |
| `PAYMENT_PARTIALLY_REFUNDED` | keep current status; record event only |
| `PAYMENT_CHARGEBACK_REQUESTED` | `past_due` (immediate) |
| `PAYMENT_CHARGEBACK_DISPUTE` | `past_due` (immediate) |
| `PAYMENT_DELETED` | `canceled` |
| `SUBSCRIPTION_DELETED` | `canceled` |
| anything else | `null` (ack 200, log) |

`BillingWebhookEvent` gains the refund/chargeback variants; `mapPgBillingError` / `BillingErrorCode` gain `gateway_error` and `model_not_allowed`.

---

## 6. API routes

### `POST /api/billing/checkout`
Authenticated (account member). Body `{ planId }`.
1. Reject unknown plan, `is_custom`, or `price_cents = 0` (`400`).
2. **Idempotency:** if a `started` `billing_checkouts` row exists for `(account_id, target_plan_id)` within the last N minutes, return its `checkout_url` (no new Asaas call).
3. Reuse `subscriptions.gateway_customer_id` if present; the checkout may also create/resolve the customer.
4. `createCheckout` → insert a `billing_checkouts` row (`status='started'`, `gateway_checkout_id`, `checkout_url`). **Do not touch `subscriptions`.** Record `billing_event` `checkout_started`.
5. Return `{ checkoutUrl }`.

### `POST /api/billing/webhook`
Public; verifies `ASAAS_WEBHOOK_TOKEN` (constant-time; mismatch → `401`, logged).
1. Insert `billing_webhook_events(event_id)`; on conflict → ack `200`, stop (idempotent).
2. `parseWebhook` → on a normalized event, resolve the target account/subscription:
   - link via `billing_checkouts.gateway_checkout_id` / `gateway_subscription_id`, marking the checkout `completed` and stamping `gateway_subscription_id` the first time.
3. Apply the status transition (table §5). On `active`: set `subscriptions.plan_id = target_plan_id`, `status='active'`, `current_period_end` from the confirmed payment, `gateway='asaas'`, clear trial; record `subscription_status_changed`.
   - **Upgrade safety:** an `active` account stays `active` on its old plan until a payment confirms — only then does `plan_id` move. A `trial`/`free`/never-paid account may sit `past_due`/blocked while awaiting first payment.
4. Always ack `200` quickly; unknown events logged and ignored.

### `POST /api/sdr/config` (modify existing)
Before persisting `model`: load the account's plan `allowed_model_keys`, resolve to concrete models, and require `b.model ∈` that set; else `400 { error: 'model_not_allowed' }`. Absent/empty `model` stays `null` (worker default). Server-side and plan-derived — the single source of truth for every caller.

---

## 7. Frontend

- `billing-settings.tsx`: plan picker (Starter/Pro/Business cards: price + limits; custom plans hidden). "Assinar/Upgrade" → `POST /api/billing/checkout` → redirect to `checkoutUrl`.
- Return URLs land on `/settings?tab=billing`; the page refetches on focus so status reflects whatever the webhook has written (may briefly lag — acceptable).
- `billing-banner.tsx`: unchanged; `past_due` already falls under `blocked` in `resolveEntitlements`, so it prompts to pay.

---

## 8. Error handling & security

- All Asaas calls wrapped; network/4xx/5xx → `BillingError('gateway_error')`, friendly toast, never leak raw gateway errors.
- Webhook token constant-time compare; `event_id` dedupe table for true idempotency.
- `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` server-only; validated present at startup when `BILLING_GATEWAY=asaas`.
- `model_not_allowed` enforced server-side from the plan; UI never trusted.
- Checkout route account-scoped (RLS + membership); a member can only subscribe their own account.

---

## 9. Testing

- **Adapter (mocked `fetch`):** checkout payload shape; `parseWebhook` mapping (each event → normalized/null); base URL + headers (`access_token`, `User-Agent`); token rejection. No live calls.
- **Checkout route:** creates exactly **one** checkout per `(account, plan)` within the idempotency window (repeat clicks reuse the URL); rejects custom/trial plans.
- **Upgrade safety:** starting an upgrade does **not** flip an `active` subscription to `past_due`; `plan_id` only changes after a confirmed webhook.
- **Webhook:** confirmed event activates; duplicate `event_id` is a no-op; `OVERDUE`/`CAPTURE_REFUSED`/`CHARGEBACK_*` → `past_due`; `REFUNDED`/`DELETED` → `canceled`.
- **Allow-list:** allowed model passes; unlisted model → `400`; custom-plan expanded keys pass.
- Gateway stubbed in CI (`BILLING_GATEWAY` unset). Manual **sandbox** checklist (sandbox key, Asaas test card, observe webhooks for confirm + a forced refund/chargeback) before prod cutover.

---

## 10. Rollout

1. Migration 033 (prices, `allowed_model_keys`, `is_custom`, `billing_checkouts`, `billing_webhook_events`).
2. Registry + adapter + routes + allow-list enforcement, gateway still stub in prod (`BILLING_GATEWAY` unset) — ships dark.
3. Configure Asaas **sandbox**; run the manual checklist end-to-end (confirm, refund, chargeback, repeat-click).
4. Flip `BILLING_GATEWAY=asaas` + prod keys + webhook URL on `zenith-sender` (web). Checkout/webhook are web-only; the worker only reads `allowed_model_keys` from the plan, so it needs migration 033 but no Asaas env.
5. Owner account stays on the manually-set `active`/`business` row (no checkout needed).
