# Billing — Cycle B (Asaas, real checkout) — Design

**Date:** 2026-06-29
**Status:** approved (design), pending spec review
**Depends on:** Cycle A (migration 032, `BillingGateway` interface, entitlements, gating). Cycle B replaces the stub gateway with a real Asaas adapter and turns the placeholder "Assinar" button into a working hosted checkout.

---

## 1. Decisions (locked in brainstorm)

| Topic | Decision |
|---|---|
| Payment method | **Credit card only** — Asaas auto-charges monthly; webhooks drive the lifecycle (hands-off recurring). |
| Card collection | **Asaas hosted checkout** — we redirect to Asaas; we never touch card data (no PCI surface). |
| Prices (standard plans) | Starter **R$97** · Pro **R$297** · Business **R$697** /month. Trial = free. |
| AI model exposure | The allowed model set is derived from the **account's plan**, validated server-side. Tenants can never self-select a model outside their plan's allow-list — including via direct API calls. |
| Standard plan models | Budget tier only: `gpt-5.4-mini` (default), `gpt-4o-mini`, `claude-haiku-4-5`. |
| Premium models | Only via **custom/enterprise plans** that the operator attaches to an account (expanded `allowed_models`). Not self-serve; priced to cover cost. |

**Out of scope (Cycle B):** dunning emails, proration on mid-cycle upgrades (upgrade takes effect next cycle / immediate re-checkout), invoices UI, multiple concurrent subscriptions, PIX/boleto, self-serve enterprise checkout.

---

## 2. Data model changes (migration 033)

Extend `plans`:

```sql
ALTER TABLE plans
  ADD COLUMN price_cents     INTEGER NOT NULL DEFAULT 0,   -- monthly price, BRL cents
  ADD COLUMN allowed_models  TEXT[]  NOT NULL DEFAULT ARRAY['gpt-5.4-mini','gpt-4o-mini','claude-haiku-4-5'],
  ADD COLUMN is_custom       BOOLEAN NOT NULL DEFAULT false; -- enterprise/negotiated, hidden from self-serve checkout

UPDATE plans SET price_cents = 9700  WHERE id = 'starter';
UPDATE plans SET price_cents = 29700 WHERE id = 'pro';
UPDATE plans SET price_cents = 69700 WHERE id = 'business';
-- trial stays price_cents = 0
```

`subscriptions` already has `gateway`, `gateway_customer_id`, `gateway_subscription_id` (Cycle A). No new columns required; Cycle B populates them with `'asaas'` and the real ids.

The model allow-list is **read from the plan**, so no per-subscription model column is needed. A custom plan row (e.g. `id='enterprise_acme'`, `is_custom=true`, expanded `allowed_models`, bespoke `price_cents`) is created by the operator and assigned by setting `subscriptions.plan_id`.

---

## 3. Asaas adapter (`src/lib/billing/gateway/asaas.ts`)

Implements the existing `BillingGateway` interface. No interface change.

- **Base URL / auth:** `ASAAS_BASE_URL` (sandbox `https://sandbox.asaas.com/api/v3` vs prod `https://api.asaas.com/v3`) + `ASAAS_API_KEY` header `access_token`.
- `createCustomer({ accountId, name, email })` → `POST /customers` → returns Asaas `id` as `customerId`. Store on `subscriptions.gateway_customer_id`.
- `createSubscription({ customerId, planId, method:'card' })` →
  - `POST /subscriptions` with `billingType: 'CREDIT_CARD'`, `cycle: 'MONTHLY'`, `value` = plan price (reais), `externalReference` = our `account_id`.
  - Card is **not** sent (hosted checkout): we surface the subscription's first payment **invoiceUrl** (Asaas hosted page) as `checkoutUrl`. Returns `{ subscriptionId, checkoutUrl }`.
- `cancelSubscription(id)` → `DELETE /subscriptions/{id}`.
- `parseWebhook(req)` → validates the shared-secret token (`ASAAS_WEBHOOK_TOKEN` via the `asaas-access-token` header), parses the event, maps to our normalized `BillingWebhookEvent`:

| Asaas event | Normalized |
|---|---|
| `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` | `subscription_active` (with `periodEnd` = paid period end) |
| `PAYMENT_OVERDUE` | `subscription_past_due` |
| `SUBSCRIPTION_DELETED` / `PAYMENT_DELETED` | `subscription_canceled` |
| anything else | `null` (ignored) |

`getGateway()` switches to the Asaas adapter when `BILLING_GATEWAY === 'asaas'`, else keeps the stub (so tests and local dev stay offline by default).

---

## 4. API routes

### `POST /api/billing/checkout`
Authenticated (account member). Body: `{ planId }`.
1. Reject if `planId` is unknown, `is_custom`, or `price_cents = 0` (trial/custom not self-serve).
2. Load/lazily-create the Asaas customer (reuse `gateway_customer_id` if present; else `createCustomer` and persist).
3. `createSubscription` → persist `gateway='asaas'`, `gateway_subscription_id`, set local status to `past_due` (not yet paid — gating stays blocked until the webhook confirms). Record `billing_event` `checkout_started`.
4. Return `{ checkoutUrl }`. Frontend redirects.

### `POST /api/billing/webhook`
Public (no session). Verifies `ASAAS_WEBHOOK_TOKEN`. Uses `parseWebhook`; on a normalized event, looks up the subscription by `gateway_subscription_id` and updates:
- `subscription_active` → `status='active'`, `current_period_end=periodEnd`, clears trial, records `subscription_status_changed`.
- `subscription_past_due` → `status='past_due'`.
- `subscription_canceled` → `status='canceled'`.
Idempotent (safe to receive duplicates — Asaas retries). Always returns `200` quickly so Asaas stops retrying; logs and swallows unknown events.

### `POST /api/sdr/config` (modify existing)
Before persisting `model`: load the account's plan `allowed_models`; if `b.model` is set and **not** in that list → `400` `{ error: 'model_not_allowed' }`. Empty/absent `model` stays `null` (worker uses the default). This closes the cost vector for every caller, UI or API.

---

## 5. Frontend

- `billing-settings.tsx`: the "Assinar / Fazer upgrade" button calls `POST /api/billing/checkout` for the chosen plan and redirects to `checkoutUrl`. Add a simple plan picker (Starter/Pro/Business cards with price + limits). Custom plans are not shown.
- After returning from Asaas, the user lands back on `/settings?tab=billing`; status reflects whatever the webhook has already written (may briefly show `past_due` until the webhook arrives — acceptable; the page polls/refetches on focus).
- `billing-banner.tsx`: already handles `blocked`/trial; `past_due` falls under `blocked` (Cycle A `resolveEntitlements`), so the banner already prompts to pay.

---

## 6. Error handling & security

- All Asaas calls wrapped; network/4xx/5xx → mapped to a `BillingError` (`gateway_error`) surfaced as a friendly toast. Never leak Asaas raw errors to the client.
- Webhook token compared with constant-time check; reject mismatches with `401` (logged).
- `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` are server-only env, validated present at startup when `BILLING_GATEWAY=asaas`.
- `model_not_allowed` enforcement is server-side and plan-derived — the single source of truth; the UI never sends an unlisted model but is not trusted.
- Checkout route is account-scoped (RLS + membership); a member can only subscribe their own account.

---

## 7. Testing

- **Unit (pure / mocked fetch):** `asaas.ts` — customer/subscription payload shape, `parseWebhook` mapping table (each Asaas event → normalized/null), token rejection. Mock `fetch`, no live calls.
- **Unit:** allow-list validation in the config route (allowed model passes, unlisted model → 400, custom-plan expanded list passes).
- **Integration (mocked gateway):** checkout route happy path (creates customer once, persists ids, returns checkoutUrl); webhook route updates status idempotently for each event type.
- Gateway stays stubbed in CI (`BILLING_GATEWAY` unset) so the suite is offline. A manual sandbox checklist (sandbox key, real test card, observe webhook) covers the live path before prod cutover.

---

## 8. Rollout

1. Migration 033 (prices, allowed_models, is_custom).
2. Adapter + routes + allow-list enforcement, gateway still stub in prod (`BILLING_GATEWAY` unset) — ships dark.
3. Configure Asaas **sandbox**, run the manual checklist end-to-end.
4. Flip `BILLING_GATEWAY=asaas` + prod keys + webhook URL on `zenith-sender` (web). The checkout and webhook routes are web-only; the worker only reads `allowed_models` from the plan, so it needs the new migration but no Asaas env.
5. Owner account stays on the manually-set `active`/`business` row (no checkout needed for the test account).
