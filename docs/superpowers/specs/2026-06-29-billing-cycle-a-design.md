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
2. **Trial:** 7 days, **no card**, on the low Trial caps. Expires on time **or** when a trial cap is hit → blocked.
3. **Expired / delinquent:** block cost-generating actions (dispatch, send, SDR), keep read access (inbox, contacts, reports). No data deletion.
4. **At-limit on an active plan:** hard block the limited action with warnings near the cap; numbers/contacts are hard limits at creation; the AI quota resets next cycle or on upgrade. (No overage billing — plans are fixed-price.)

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

## Quota counting (AI messages)

`src/lib/billing/quota.ts`: `consumeAiMessage(db, accountId)` (service-role) —
atomically: if `now > cycle_reset_at`, set `ai_messages_used=1`,
`cycle_reset_at=now()+30d`; else `ai_messages_used = ai_messages_used + 1`.
Implemented as a single `UPDATE ... RETURNING` (or a small SQL function) so
concurrent SDR runs don't lose increments. Called by the worker right before a
billable AI/SDR send, after the `canUseSdr` check.

## Enforcement points

- **Send** (`/api/whatsapp/send`) and **Broadcast** (`/api/whatsapp/broadcast`):
  load entitlements; if `!canDispatch` → `402` with `reason`.
- **SDR** (worker, `decideFromContext` path or the worker before the LLM call):
  load entitlements for the conversation's account; if `!canUseSdr` → log an
  `sdr_runs` row `action='noop'` (reason: billing) and stop; otherwise
  `consumeAiMessage` then proceed.
- **Connect channel** (`POST /api/channels`, a server route): count existing
  channels; if `>= max_numbers` → `403` with an upgrade message.
- **Create contact** — contacts are inserted **client-side via the
  RLS-governed client** (the import modal, the contact form), so an app-level
  gate isn't bypass-proof. Enforce in the DB instead: a `BEFORE INSERT` trigger
  `enforce_contact_limit()` (SECURITY DEFINER) on `contacts` that counts the
  account's contacts and `RAISE`s a clear error (SQLSTATE `P0001`, message
  `contact_limit_reached`) when it would exceed the account's plan
  `max_contacts`. The contact form and the importer catch that error and show
  "limite do plano atingido — assine/atualize para adicionar mais contatos"
  (the importer reports how many rows were skipped). App-level pre-checks (hide
  "add" when at the cap) are UX polish on top of the DB backstop.

A small server helper `requireEntitlement(accountId, 'dispatch' | 'sdr')` keeps
the route checks one-liners.

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

- `supabase/migrations/032_billing.sql` (schema + seed + backfill + the
  `enforce_contact_limit()` function and `BEFORE INSERT` trigger on `contacts`)
- `src/lib/billing/entitlements.ts` (pure) + test
- `src/lib/billing/load-entitlements.ts`
- `src/lib/billing/quota.ts` (consumeAiMessage) + test
- `src/lib/billing/require-entitlement.ts` (route helper)
- `src/lib/billing/ensure-subscription.ts` (trial init helper)
- `src/lib/billing/gateway/types.ts`, `stub.ts`, `index.ts` (factory)
- Enforcement edits: `src/app/api/whatsapp/send/route.ts`, `.../broadcast/route.ts`, `src/app/api/channels/route.ts`, the contact create/import insert path, and the SDR worker (`src/worker/sdr-worker.ts` / core).
- UI: `src/components/settings/billing-settings.tsx` + a section in the settings rail; a `BillingBanner` in the app shell.

## Testing

- `resolveEntitlements` (pure): trialing active, trial expired, past_due,
  canceled, AI quota full, lazy cycle reset, blocked flag, trialDaysLeft.
- `consumeAiMessage`: increments; resets when past `cycle_reset_at` (fake db).
- Enforcement helpers: blocked vs allowed for each gate (mock entitlements).
- `StubGateway`: returns ids; factory picks stub by default.

## Out of scope (Cycle B)

- `AsaasGateway` (real createCustomer/subscription, Pix Automático + card).
- Webhook route `/api/billing/webhook` (verify + apply `BillingWebhookEvent`).
- Real checkout flow + the subscribe/upgrade button wiring.
- Dunning/retries, invoices, proration.
