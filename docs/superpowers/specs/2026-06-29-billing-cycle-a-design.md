# Billing — Cycle A (Gating Core) — Design

**Status:** approved (design) · **Date:** 2026-06-29

## Context

Zenith Sender (a multi-tenant WhatsApp dispatch + AI-SDR SaaS, built on the
wacrm base) has no billing. Multi-tenancy exists (`accounts` + RLS via
`is_account_member`, `platform_admins`). We're adding subscription billing.

Billing is decomposed into two cycles:

- **Cycle A (this spec) — gating core:** plans, trial, subscription state,
  entitlements, enforcement, quota counting. Built and tested against a
  **stub gateway** — no external dependency. Delivers an app that respects
  plan limits and trials end-to-end.
- **Cycle B (separate spec, later) — payment integration:** the Asaas adapter
  (create customer/subscription, webhooks), checkout, reconciliation. Plugs
  real money into the already-solid core.

Building A first (a tested entitlement core) before B (the gateway) is the safe
order — never wire real payments to a flaky gating layer.

## Decisions (from brainstorming)

1. **Plans:** three tiers + a trial, limited by **connected numbers**, **contacts**, **AI/SDR messages per month**:

   | Plan | numbers | contacts | ai_messages/mo |
   |------|---------|----------|----------------|
   | Trial | 1 | 50 | 50 |
   | Starter | 1 | 1 000 | 500 |
   | Pro | 3 | 10 000 | 5 000 |
   | Business | 10 | 50 000 | 20 000 |

   Prices are configurable (set later in Asaas + the `plans` row); not needed in Cycle A.
2. **Trial:** 7 days, **no card**, on the low Trial caps. Expires **by time
   only** — hitting a contact/number/AI cap does **not** end the trial. Each
   cap blocks **only its own action** (a full AI quota blocks SDR/AI; the
   contact cap blocks new contacts; the number cap blocks new channels); the
   account stays in `trialing` until `trial_ends_at`. The UI nudges upgrade
   whenever any cap is reached.
3. **Expired / delinquent:** block cost-generating actions (dispatch, send, SDR), keep read access (inbox, contacts, reports). No data deletion.
4. **At-limit on an active plan:** hard block the limited action with warnings near the cap; numbers/contacts are hard limits at creation; the AI quota resets next cycle or on upgrade. (No overage billing — plans are fixed-price.) A per-limit block never changes `status` — only `trial_ends_at`/payment does.

## Architecture

```
signup → create subscription (trialing, plan=trial, +7d)
                              │
   server cost-gates ─────────┤  resolveEntitlements(sub, plan, now)
   (send / broadcast / SDR /  │     → { canDispatch, canUseSdr, limits, aiRemaining, blocked, … }
    connect channel / contact)│
                              │  block (402/limit message) when not allowed
   gateway adapter ───────────┘  BillingGateway interface (+ StubGateway in A)
```

## Schema — `supabase/migrations/032_billing.sql`

`plans` (config; seeded):
- `id TEXT PRIMARY KEY` — `'trial' | 'starter' | 'pro' | 'business'`
- `name TEXT NOT NULL`
- `max_numbers INT NOT NULL`, `max_contacts INT NOT NULL`, `max_ai_messages INT NOT NULL`
- `is_trial BOOLEAN NOT NULL DEFAULT false`
- `sort INT NOT NULL DEFAULT 0` (display order)
- RLS: readable by any authenticated user (it's public pricing config); no member writes.
- Seed the four rows above.

`subscriptions` (one per account):
- `account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE`
- `plan_id TEXT NOT NULL REFERENCES plans(id)`
- `status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled'))`
- `trial_ends_at TIMESTAMPTZ`
- `current_period_end TIMESTAMPTZ`
- `ai_messages_used INT NOT NULL DEFAULT 0`
- `cycle_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')`
- `gateway TEXT`, `gateway_customer_id TEXT`, `gateway_subscription_id TEXT`
- `created_at`, `updated_at` (with the standard `update_updated_at_column` trigger)
- RLS: `SELECT` for `is_account_member(account_id)`; **no** INSERT/UPDATE/DELETE policy for authenticated — writes come from the service-role client (signup hook, webhooks, quota counter) which bypasses RLS, so a signed-in user can't forge their own plan/quota.

`billing_events` (lightweight audit trail):
- `id UUID PK`, `account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`
- `type TEXT NOT NULL CHECK (type IN ('trial_started','ai_quota_consumed','ai_quota_blocked','contact_limit_reached','channel_limit_reached','subscription_status_changed'))`
- `metadata JSONB NOT NULL DEFAULT '{}'`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- RLS: `SELECT` for `is_account_member(account_id)`; writes are service-role only.
- **Emission policy:** the discrete, low-frequency events are emitted —
  `trial_started` (on subscription creation), `ai_quota_blocked` (when a run is
  refused for no quota), `contact_limit_reached`, `channel_limit_reached`,
  `subscription_status_changed`. `ai_quota_consumed` is a **supported type but
  NOT emitted per message by default** — every SDR run is already recorded in
  `sdr_runs`, and a row per AI message would double write volume. The type
  exists so Cycle B (or a sampled job) can use it without a migration.

**Indexes** (in 032): `contacts(account_id)`, `channels(account_id)`,
`subscriptions(plan_id)`, and `billing_events(account_id, created_at DESC)`.

## Trial initialization

A new account must get a `subscriptions` row (`status='trialing'`, `plan_id='trial'`,
`trial_ends_at = now()+7d`, `cycle_reset_at = now()+7d`). Implementation: a
service-role helper `ensureSubscription(accountId)` called from the existing
account-creation path (the signup/account-bootstrap server code). Idempotent
(`ON CONFLICT (account_id) DO NOTHING`). A backfill in the migration inserts a
trialing row for any pre-existing account so nothing is left without a row.

## Entitlements — `src/lib/billing/entitlements.ts` (pure)

```ts
export interface PlanLimits {
  max_numbers: number
  max_contacts: number
  max_ai_messages: number
}
export interface SubscriptionRow {
  status: 'trialing' | 'active' | 'past_due' | 'canceled'
  plan_id: string
  trial_ends_at: string | null
  current_period_end: string | null
  ai_messages_used: number
  cycle_reset_at: string
}
export interface Entitlements {
  active: boolean          // trial-not-expired OR status active
  blocked: boolean         // !active — cost + growth actions blocked; reads
                           // and edits of existing CRM data still allowed
  canDispatch: boolean     // send/broadcast allowed (== active)
  canUseSdr: boolean       // SDR/AI allowed (active AND ai quota left)
  limits: PlanLimits       // max_numbers / max_contacts / max_ai_messages
  aiUsed: number
  aiRemaining: number
  trialDaysLeft: number | null
  reason: string           // why blocked, for the UI banner
}

export function resolveEntitlements(
  sub: SubscriptionRow, plan: PlanLimits, now?: number,
): Entitlements
```

Note: number/contact admission needs the *current count*, which the pure
function doesn't have — those checks combine `active` (from here) with a live
count at the gate (the channel route; the contacts DB trigger). Only the AI
quota lives in the subscription row, so `canUseSdr` is fully resolvable here.

Rules:
- `active` = `status==='active'` OR (`status==='trialing'` AND `now <= trial_ends_at`).
- Not active (`trialing` past `trial_ends_at`, or `past_due`/`canceled`) → `blocked=true`, `canDispatch=false`, `canUseSdr=false`, `reason` set.
- Lazy cycle reset: if `now > cycle_reset_at`, treat `ai_messages_used` as 0 for `aiRemaining` (the actual DB reset happens in the counter — see below).
- `aiRemaining = max(0, max_ai_messages − effectiveUsed)`; `canUseSdr = active && aiRemaining > 0`.
- `trialDaysLeft` = ceil days to `trial_ends_at` when trialing, else null.

`resolveEntitlements` is pure (now injectable) and the heart of the test suite.

## Loading the account's entitlements

`src/lib/billing/load-entitlements.ts`: `getAccountEntitlements(db, accountId)`
— reads the `subscriptions` row + its `plans` row and returns `Entitlements`
via `resolveEntitlements`. Two variants: server (service-role, for worker /
enforcement) and a thin client read for the UI.

## Quota counting (AI messages) — atomic, concurrency-proof

A separate "check then increment" loses under concurrency (two worker runs both
read `used=499/500` and both proceed → 501). So the **check + increment is a
single atomic DB operation**: a Postgres function (in 032), called via RPC.

```sql
-- Returns the remaining quota after consuming one; RAISEs on block/exceeded.
CREATE FUNCTION consume_ai_message(p_account uuid) RETURNS integer AS $$
DECLARE s subscriptions%ROWTYPE; p plans%ROWTYPE; used int; remaining int;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE account_id = p_account FOR UPDATE; -- row lock
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_blocked' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM plans WHERE id = s.plan_id;

  -- active = paid OR trial-not-expired (time only)
  IF NOT (s.status = 'active'
          OR (s.status = 'trialing' AND s.trial_ends_at > now())) THEN
    RAISE EXCEPTION 'billing_blocked' USING ERRCODE = 'P0001';
  END IF;

  -- lazy cycle reset
  IF now() > s.cycle_reset_at THEN
    used := 0; UPDATE subscriptions SET cycle_reset_at = now() + interval '30 days' WHERE account_id = p_account;
  ELSE used := s.ai_messages_used; END IF;

  IF used >= p.max_ai_messages THEN
    RAISE EXCEPTION 'ai_quota_exceeded' USING ERRCODE = 'P0001';
  END IF;

  UPDATE subscriptions SET ai_messages_used = used + 1, updated_at = now()
    WHERE account_id = p_account;
  remaining := p.max_ai_messages - (used + 1);
  RETURN remaining;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;
```

`src/lib/billing/quota.ts`: `consumeAiMessageOrThrow(db, accountId): Promise<number>`
— calls `db.rpc('consume_ai_message', { p_account: accountId })`; on a Postgres
error maps the message to a typed `BillingError` (`billing_blocked` /
`ai_quota_exceeded`) the caller can branch on; otherwise returns the remaining
count. The worker calls this **instead of** a separate check+increment: if it
throws `ai_quota_exceeded` or `billing_blocked`, the SDR run logs an `sdr_runs`
`action='noop'` (billing reason) + a `billing_events` `ai_quota_blocked` and
stops; if it succeeds, the AI reply proceeds (the increment already happened
atomically, so a crash after sending at worst under-charges by one — safe).

## Enforcement points

- **Send** (`/api/whatsapp/send`) and **Broadcast** (`/api/whatsapp/broadcast`):
  load entitlements; if `!canDispatch` → `402` with `reason`.
- **SDR** (worker, right before the billable LLM reply): call
  `consumeAiMessageOrThrow(db, accountId)` — the **atomic** check+increment. On
  `billing_blocked` / `ai_quota_exceeded` → log an `sdr_runs` `action='noop'`
  (billing reason) + a `billing_events` `ai_quota_blocked`, and stop. On success
  the reply proceeds (quota already incremented atomically). Do **not** do a
  separate `canUseSdr` pre-check as the gate — that reintroduces the race;
  `canUseSdr` is only for the UI.
- **Connect channel** (`POST /api/channels`, a server route): count existing
  channels; if `>= max_numbers` → `403` with an upgrade message.
- **Create contact** — contacts are inserted **client-side via the
  RLS-governed client** (the import modal, the contact form), so an app-level
  gate isn't bypass-proof. Enforce in the DB: a `BEFORE INSERT` trigger
  `enforce_contact_limit()` (SECURITY DEFINER) on `contacts`. To prevent a
  count-then-insert race during **concurrent imports**, the function first takes
  a per-account transactional advisory lock —
  `PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id::text, 0))` —
  so inserts for the same account serialize; then counts and `RAISE`s
  `contact_limit_reached` (SQLSTATE `P0001`) if it would exceed the plan's
  `max_contacts`. Requires the `contacts(account_id)` index (added in 032) so
  the count is cheap. The contact form and the importer catch that error and
  show "limite do plano atingido — assine/atualize para adicionar mais
  contatos" (the importer reports how many rows were skipped). App-level
  pre-checks (hide "add" at the cap) are UX polish on top of the DB backstop.

A small server helper `requireEntitlement(accountId, 'dispatch')` keeps the
route checks one-liners (loads entitlements, returns the standardized error
response when blocked).

## Standardized billing errors

One shape across every billing/limit failure, so the client can branch on a
stable `code`:

```ts
// src/lib/billing/errors.ts
export type BillingErrorCode =
  | 'billing_blocked'        // subscription inactive (trial expired / past_due / canceled)
  | 'plan_limit_reached'     // generic plan cap (umbrella)
  | 'ai_quota_exceeded'      // monthly AI/SDR quota hit
  | 'contact_limit_reached'  // max_contacts hit
  | 'channel_limit_reached'  // max_numbers hit
export interface BillingErrorBody { error: { code: BillingErrorCode; message: string } }
export class BillingError extends Error { constructor(public code: BillingErrorCode, message?: string) { super(message ?? code) } }
/** NextResponse with the standard body + status (402 blocked/quota, 403 caps). */
export function billingErrorResponse(code: BillingErrorCode, message?: string): NextResponse
```

- API routes return `billingErrorResponse(code, …)` — `402` for
  `billing_blocked`/`ai_quota_exceeded`, `403` for the `*_limit_reached` caps.
- DB RAISEs use the **same strings** as the message (`contact_limit_reached`,
  `ai_quota_exceeded`, `billing_blocked`), so the TS layer maps a Postgres error
  message straight to a `BillingErrorCode` (a small `mapPgBillingError(err)`).
- The client maps each `code` to a friendly pt-BR message + an "upgrade" CTA.

## UI

- **Settings → Billing** (new section in the settings rail): current plan,
  three **usage bars** (numbers / contacts / AI this cycle vs limits), trial
  days left, and a "Assinar / Fazer upgrade" button. In Cycle A the button
  routes to a placeholder ("checkout em breve"); Cycle B wires the real flow.
- **Global banner** (dashboard / app shell): shown when trialing with
  `trialDaysLeft <= 2` ("seu teste termina em N dias") or blocked ("conta
  bloqueada — assine para voltar a disparar"), linking to Settings → Billing.

## Gateway adapter — `src/lib/billing/gateway/`

Define the provider-agnostic interface now so Cycle B is just an implementation:

```ts
export interface BillingGateway {
  createCustomer(input: { accountId: string; name: string; email?: string }): Promise<{ customerId: string }>
  createSubscription(input: { customerId: string; planId: string; method: 'pix' | 'card' }): Promise<{ subscriptionId: string; checkoutUrl?: string }>
  cancelSubscription(subscriptionId: string): Promise<void>
  /** Map a provider webhook request to a normalized event. */
  parseWebhook(req: Request): Promise<BillingWebhookEvent | null>
}
export type BillingWebhookEvent =
  | { type: 'subscription_active'; gatewaySubscriptionId: string; periodEnd: string }
  | { type: 'subscription_past_due'; gatewaySubscriptionId: string }
  | { type: 'subscription_canceled'; gatewaySubscriptionId: string }
```

- `StubGateway` (Cycle A): no-op/in-memory, returns deterministic ids — lets the
  enforcement + UI work end-to-end and be tested without Asaas.
- `getGateway()` factory by env (`BILLING_GATEWAY=stub|asaas`), default `stub`.
- `AsaasGateway` is Cycle B.

## Files

- `supabase/migrations/032_billing.sql` — `plans` + `subscriptions` +
  `billing_events`; the `consume_ai_message()` and `enforce_contact_limit()`
  functions + the contacts trigger; the indexes; seed (4 plans) + trial backfill.
- `src/lib/billing/entitlements.ts` (pure) + `entitlements.test.ts`
- `src/lib/billing/errors.ts` (`BillingError`, codes, `billingErrorResponse`, `mapPgBillingError`)
- `src/lib/billing/load-entitlements.ts` (`getAccountEntitlements`)
- `src/lib/billing/quota.ts` (`consumeAiMessageOrThrow`) + `quota.test.ts` (incl. simulated concurrency)
- `src/lib/billing/require-entitlement.ts` (route helper)
- `src/lib/billing/ensure-subscription.ts` (trial init helper; emits `trial_started`)
- `src/lib/billing/events.ts` (`recordBillingEvent(db, accountId, type, metadata?)`, service-role)
- `src/lib/billing/gateway/types.ts`, `stub.ts`, `index.ts` (factory, default `stub`)
- Enforcement edits: `src/app/api/whatsapp/send/route.ts`, `.../broadcast/route.ts`, `src/app/api/channels/route.ts` (channel cap + `channel_limit_reached` event), and the SDR worker (`consumeAiMessageOrThrow`).
- Account-creation hook calls `ensureSubscription` (find the signup/bootstrap path).
- UI: `src/components/settings/billing-settings.tsx` + a `billing` section in the settings rail/sections; a `BillingBanner` in the app shell; client error→message mapping.

## Testing (acceptance criteria)

- `resolveEntitlements` (pure): trialing-active, trial-expired (by time only —
  a hit cap does NOT expire it), past_due, canceled, AI quota full, lazy cycle
  reset, `blocked` flag, `trialDaysLeft`. Main states covered.
- **Quota concurrency:** `consume_ai_message` must never exceed the limit under
  parallel calls. Test by firing N concurrent `consumeAiMessageOrThrow` against
  a near-limit subscription (against a real Postgres in CI, or a focused test
  that asserts the function's `FOR UPDATE` + atomic update logic) and asserting
  exactly `limit` succeed and the rest throw `ai_quota_exceeded`.
- `mapPgBillingError` / `billingErrorResponse`: each code → right status + body.
- Enforcement helpers: blocked vs allowed per gate (mock entitlements).
- `StubGateway`: returns deterministic ids; factory defaults to stub.
- Trial init: `ensureSubscription` creates a trialing row + `trial_started`
  event; idempotent. Backfill covers pre-existing accounts (verified via SQL
  after applying the migration).

## Out of scope (Cycle B)

- `AsaasGateway` (real createCustomer/subscription, Pix Automático + card).
- Webhook route `/api/billing/webhook` (verify + apply `BillingWebhookEvent`).
- Real checkout flow + the subscribe/upgrade button wiring.
- Dunning/retries, invoices, proration.
