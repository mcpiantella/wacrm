# Billing Cycle A (Gating Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subscription gating — plans, a 7-day trial, atomic AI-quota enforcement, contact/number caps, and a billing UI — all enforced server/DB-side, with a stub gateway (real payments are Cycle B).

**Architecture:** A migration adds `plans`/`subscriptions`/`billing_events`, an atomic `consume_ai_message()` SQL function, an advisory-locked `enforce_contact_limit()` trigger, and a trial-init trigger on `accounts`. A pure `resolveEntitlements()` decides allow/block from the subscription; routes + the SDR worker enforce it; standardized `BillingError` codes flow to the UI.

**Tech Stack:** Next.js 16, Supabase (project `raqfuattunokpbozdhkc`, migrations via MCP — next is 032), Vitest.

**Out of scope (Cycle B):** real Asaas gateway, webhook route, checkout. The subscribe button is a placeholder; the gateway is a stub.

---

## File Structure

- `supabase/migrations/032_billing.sql` — tables, indexes, seed, `consume_ai_message()`, `enforce_contact_limit()` + trigger, `init_trial_subscription()` + trigger on `accounts`, RLS, backfill.
- `src/lib/billing/entitlements.ts` — pure `resolveEntitlements` + types.
- `src/lib/billing/errors.ts` — `BillingError`, codes, `billingErrorResponse`, `mapPgBillingError`.
- `src/lib/billing/load-entitlements.ts` — `getAccountEntitlements(db, accountId)`.
- `src/lib/billing/events.ts` — `recordBillingEvent(db, accountId, type, metadata?)`.
- `src/lib/billing/quota.ts` — `consumeAiMessageOrThrow(db, accountId)`.
- `src/lib/billing/require-entitlement.ts` — `requireDispatch(accountId)` route helper.
- `src/lib/billing/gateway/{types.ts,stub.ts,index.ts}` — adapter interface + stub + factory.
- Enforcement edits: `send`/`broadcast`/`channels` routes, the SDR worker.
- UI: `src/components/settings/billing-settings.tsx`, settings rail entry, `BillingBanner`.

---

## Task 1: Migration 032 (schema, functions, triggers, seed, backfill)

**Files:** Create `supabase/migrations/032_billing.sql`.

- [ ] **Step 1: Write the migration file** with exactly this SQL:

```sql
-- ============================================================
-- 032_billing.sql — Billing Cycle A (gating core).
-- plans + subscriptions + billing_events; atomic AI-quota function;
-- advisory-locked contact-limit trigger; trial init on account create.
-- ============================================================

-- ---- plans (config) ----
CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  max_numbers     INTEGER NOT NULL,
  max_contacts    INTEGER NOT NULL,
  max_ai_messages INTEGER NOT NULL,
  is_trial        BOOLEAN NOT NULL DEFAULT false,
  sort            INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans FOR SELECT TO authenticated USING (true);

INSERT INTO plans (id, name, max_numbers, max_contacts, max_ai_messages, is_trial, sort) VALUES
  ('trial',    'Trial',     1, 50,    50,    true,  0),
  ('starter',  'Starter',   1, 1000,  500,   false, 1),
  ('pro',      'Pro',       3, 10000, 5000,  false, 2),
  ('business', 'Business', 10, 50000, 20000, false, 3)
ON CONFLICT (id) DO NOTHING;

-- ---- subscriptions (one per account) ----
CREATE TABLE IF NOT EXISTS subscriptions (
  account_id              UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id                 TEXT NOT NULL REFERENCES plans(id),
  status                  TEXT NOT NULL DEFAULT 'trialing'
                            CHECK (status IN ('trialing','active','past_due','canceled')),
  trial_ends_at           TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  ai_messages_used        INTEGER NOT NULL DEFAULT 0,
  cycle_reset_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  gateway                 TEXT,
  gateway_customer_id     TEXT,
  gateway_subscription_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions (plan_id);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS set_updated_at ON subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policy: writes are service-role only.

-- ---- billing_events (audit) ----
CREATE TABLE IF NOT EXISTS billing_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN (
               'trial_started','ai_quota_consumed','ai_quota_blocked',
               'contact_limit_reached','channel_limit_reached','subscription_status_changed')),
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_events_account ON billing_events (account_id, created_at DESC);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_events_select ON billing_events;
CREATE POLICY billing_events_select ON billing_events FOR SELECT USING (is_account_member(account_id));

-- ---- count indexes for the gates ----
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts (account_id);
CREATE INDEX IF NOT EXISTS idx_channels_account ON channels (account_id);

-- ---- atomic AI-quota consume ----
CREATE OR REPLACE FUNCTION consume_ai_message(p_account UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s subscriptions%ROWTYPE; p plans%ROWTYPE; used INT; remaining INT;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_blocked' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM plans WHERE id = s.plan_id;

  IF NOT (s.status = 'active'
          OR (s.status = 'trialing' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at > now())) THEN
    RAISE EXCEPTION 'billing_blocked' USING ERRCODE = 'P0001';
  END IF;

  IF now() > s.cycle_reset_at THEN
    used := 0;
    UPDATE subscriptions SET cycle_reset_at = now() + interval '30 days' WHERE account_id = p_account;
  ELSE
    used := s.ai_messages_used;
  END IF;

  IF used >= p.max_ai_messages THEN
    RAISE EXCEPTION 'ai_quota_exceeded' USING ERRCODE = 'P0001';
  END IF;

  UPDATE subscriptions SET ai_messages_used = used + 1, updated_at = now() WHERE account_id = p_account;
  remaining := p.max_ai_messages - (used + 1);
  RETURN remaining;
END; $$;

-- ---- contact-limit trigger (advisory lock per account) ----
CREATE OR REPLACE FUNCTION enforce_contact_limit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE max_c INT; cnt INT;
BEGIN
  -- Serialize concurrent inserts for the same account so the count-then-insert
  -- can't race during parallel imports.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id::text, 0));
  SELECT p.max_contacts INTO max_c
    FROM subscriptions sub JOIN plans p ON p.id = sub.plan_id
    WHERE sub.account_id = NEW.account_id;
  IF max_c IS NULL THEN RETURN NEW; END IF; -- no subscription row → don't block
  SELECT count(*) INTO cnt FROM contacts WHERE account_id = NEW.account_id;
  IF cnt >= max_c THEN
    RAISE EXCEPTION 'contact_limit_reached' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_enforce_contact_limit ON contacts;
CREATE TRIGGER trg_enforce_contact_limit BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION enforce_contact_limit();

-- ---- trial init on account creation (covers all account-create paths) ----
CREATE OR REPLACE FUNCTION init_trial_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at, cycle_reset_at)
  VALUES (NEW.id, 'trial', 'trialing', now() + interval '7 days', now() + interval '7 days')
  ON CONFLICT (account_id) DO NOTHING;
  INSERT INTO billing_events (account_id, type) VALUES (NEW.id, 'trial_started');
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_init_trial ON accounts;
CREATE TRIGGER trg_init_trial AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION init_trial_subscription();

-- ---- backfill existing accounts ----
INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at, cycle_reset_at)
SELECT a.id, 'trial', 'trialing', now() + interval '7 days', now() + interval '7 days'
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id);
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, name `billing`, project `raqfuattunokpbozdhkc`).

- [ ] **Step 3: Verify schema + seed + backfill** (MCP `execute_sql`):

```sql
select id, max_numbers, max_contacts, max_ai_messages from plans order by sort;
select count(*) as accounts, (select count(*) from subscriptions) as subs from accounts;
```
Expected: 4 plan rows; `accounts == subs` (every account has a subscription).

- [ ] **Step 4: Verify the atomic quota function caps correctly** — pick the owner account and confirm it never exceeds. Run (MCP):

```sql
-- temporarily set a tiny limit on a throwaway: use the trial account's own limit (50)
-- fire 3 consumes; all should return decreasing remaining without error on a fresh cycle
select consume_ai_message((select id from accounts limit 1));
select consume_ai_message((select id from accounts limit 1));
```
Expected: returns integers (remaining), decreasing. (A full concurrency assertion is in Task 5.) Then reset it so the live account isn't dirtied:
```sql
update subscriptions set ai_messages_used = 0 where account_id = (select id from accounts limit 1);
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/032_billing.sql
git commit -m "feat(billing): schema, atomic quota fn, contact-limit trigger, trial init + backfill"
```

---

## Task 2: Pure entitlements

**Files:** Create `src/lib/billing/entitlements.ts` + `src/lib/billing/entitlements.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from './entitlements'

const plan: PlanLimits = { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 }
const DAY = 86_400_000
const base = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: 'trialing', plan_id: 'trial',
  trial_ends_at: new Date(Date.now() + 3 * DAY).toISOString(),
  current_period_end: null, ai_messages_used: 0,
  cycle_reset_at: new Date(Date.now() + 10 * DAY).toISOString(),
  ...over,
})

describe('resolveEntitlements', () => {
  it('trialing within window is active and can dispatch + use SDR', () => {
    const e = resolveEntitlements(base(), plan)
    expect(e.active).toBe(true)
    expect(e.canDispatch).toBe(true)
    expect(e.canUseSdr).toBe(true)
    expect(e.trialDaysLeft).toBe(3)
  })
  it('expired trial (time only) is blocked', () => {
    const e = resolveEntitlements(base({ trial_ends_at: new Date(Date.now() - DAY).toISOString() }), plan)
    expect(e.active).toBe(false)
    expect(e.blocked).toBe(true)
    expect(e.canDispatch).toBe(false)
    expect(e.canUseSdr).toBe(false)
    expect(e.reason).toBe('trial_expired')
  })
  it('a hit AI cap blocks SDR but NOT dispatch, and does not expire the trial', () => {
    const e = resolveEntitlements(base({ ai_messages_used: 50 }), plan)
    expect(e.active).toBe(true)        // trial still active (time-based)
    expect(e.canDispatch).toBe(true)
    expect(e.canUseSdr).toBe(false)    // quota gates SDR only
    expect(e.aiRemaining).toBe(0)
    expect(e.reason).toBe('ai_quota_exceeded')
  })
  it('past_due / canceled are blocked', () => {
    expect(resolveEntitlements(base({ status: 'past_due' }), plan).canDispatch).toBe(false)
    expect(resolveEntitlements(base({ status: 'canceled' }), plan).reason).toBe('canceled')
  })
  it('lazy cycle reset: past cycle_reset_at, quota reads as fresh', () => {
    const e = resolveEntitlements(
      base({ status: 'active', trial_ends_at: null, ai_messages_used: 50, cycle_reset_at: new Date(Date.now() - DAY).toISOString() }),
      plan,
    )
    expect(e.aiUsed).toBe(0)
    expect(e.aiRemaining).toBe(50)
    expect(e.canUseSdr).toBe(true)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/billing/entitlements.test.ts`.

- [ ] **Step 3: Implement `src/lib/billing/entitlements.ts`**

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
  active: boolean
  blocked: boolean
  canDispatch: boolean
  canUseSdr: boolean
  limits: PlanLimits
  aiUsed: number
  aiRemaining: number
  trialDaysLeft: number | null
  reason: string
}

const DAY_MS = 86_400_000

/**
 * Pure entitlement resolution from a subscription + its plan. Trial expires by
 * TIME only; a hit AI cap blocks SDR but not dispatch and never changes status.
 * `now` is injectable for tests.
 */
export function resolveEntitlements(
  sub: SubscriptionRow,
  plan: PlanLimits,
  now: number = Date.now(),
): Entitlements {
  const trialing = sub.status === 'trialing'
  const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null
  const active =
    sub.status === 'active' || (trialing && trialEnds !== null && now <= trialEnds)

  const cycleReset = new Date(sub.cycle_reset_at).getTime()
  const aiUsed = now > cycleReset ? 0 : sub.ai_messages_used
  const aiRemaining = Math.max(0, plan.max_ai_messages - aiUsed)

  const canDispatch = active
  const canUseSdr = active && aiRemaining > 0
  const trialDaysLeft =
    trialing && trialEnds !== null ? Math.max(0, Math.ceil((trialEnds - now) / DAY_MS)) : null

  let reason = ''
  if (!active) {
    reason =
      sub.status === 'past_due' ? 'past_due' : sub.status === 'canceled' ? 'canceled' : 'trial_expired'
  } else if (aiRemaining === 0) {
    reason = 'ai_quota_exceeded'
  }

  return {
    active,
    blocked: !active,
    canDispatch,
    canUseSdr,
    limits: plan,
    aiUsed,
    aiRemaining,
    trialDaysLeft,
    reason,
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/billing/entitlements.test.ts`.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + `npx eslint src/lib/billing/entitlements.ts src/lib/billing/entitlements.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/billing/entitlements.ts src/lib/billing/entitlements.test.ts
git commit -m "feat(billing): pure resolveEntitlements"
```

---

## Task 3: Standardized billing errors

**Files:** Create `src/lib/billing/errors.ts` + `src/lib/billing/errors.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { BillingError, billingErrorResponse, mapPgBillingError } from './errors'

describe('billing errors', () => {
  it('maps a Postgres error message to a code', () => {
    expect(mapPgBillingError({ message: 'ai_quota_exceeded' })).toBe('ai_quota_exceeded')
    expect(mapPgBillingError({ message: 'contact_limit_reached (P0001)' })).toBe('contact_limit_reached')
    expect(mapPgBillingError({ message: 'something else' })).toBeNull()
  })
  it('builds a response with the right status + body', async () => {
    const res = billingErrorResponse('billing_blocked')
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('billing_blocked')
    expect(typeof body.error.message).toBe('string')
    expect(billingErrorResponse('channel_limit_reached').status).toBe(403)
  })
  it('BillingError carries the code', () => {
    expect(new BillingError('ai_quota_exceeded').code).toBe('ai_quota_exceeded')
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/lib/billing/errors.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + eslint on both files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/billing/errors.ts src/lib/billing/errors.test.ts
git commit -m "feat(billing): standardized billing error codes + responses"
```

---

## Task 4: Load entitlements + events + quota wrapper

**Files:** Create `src/lib/billing/load-entitlements.ts`, `src/lib/billing/events.ts`, `src/lib/billing/quota.ts` + `src/lib/billing/quota.test.ts`.

- [ ] **Step 1: Write the failing quota test** — `src/lib/billing/quota.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { consumeAiMessageOrThrow } from './quota'
import { BillingError } from './errors'

function db(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Parameters<typeof consumeAiMessageOrThrow>[0]
}

describe('consumeAiMessageOrThrow', () => {
  it('returns the remaining quota on success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 49, error: null })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).resolves.toBe(49)
    expect(rpc).toHaveBeenCalledWith('consume_ai_message', { p_account: 'acc-1' })
  })
  it('throws a typed BillingError when the function raises a known code', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'ai_quota_exceeded' } })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).rejects.toMatchObject({
      name: 'BillingError', code: 'ai_quota_exceeded',
    })
  })
  it('rethrows an unrelated error untouched', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).rejects.not.toBeInstanceOf(BillingError)
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the three files.**

`src/lib/billing/quota.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { BillingError, mapPgBillingError } from './errors'

/**
 * Atomically consume one AI message for the account (the SQL function does the
 * check + increment under a row lock). Returns the remaining quota, or throws a
 * typed BillingError ('billing_blocked' | 'ai_quota_exceeded'). Unrelated DB
 * errors are rethrown as-is.
 */
export async function consumeAiMessageOrThrow(
  db: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { data, error } = await db.rpc('consume_ai_message', { p_account: accountId })
  if (error) {
    const code = mapPgBillingError(error)
    if (code) throw new BillingError(code)
    throw error
  }
  return data as number
}
```

`src/lib/billing/events.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export type BillingEventType =
  | 'trial_started'
  | 'ai_quota_consumed'
  | 'ai_quota_blocked'
  | 'contact_limit_reached'
  | 'channel_limit_reached'
  | 'subscription_status_changed'

/** Best-effort audit write (service-role). Never throws — auditing must not
 *  break the action it records. */
export async function recordBillingEvent(
  db: SupabaseClient,
  accountId: string,
  type: BillingEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from('billing_events').insert({ account_id: accountId, type, metadata })
  } catch (err) {
    console.error('[billing] event insert failed:', err)
  }
}
```

`src/lib/billing/load-entitlements.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntitlements, type Entitlements, type PlanLimits, type SubscriptionRow } from './entitlements'

const FALLBACK_PLAN: PlanLimits = { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 }

/**
 * Load the account's subscription + plan and resolve entitlements. A missing
 * subscription (shouldn't happen post-backfill/trigger) is treated as blocked.
 */
export async function getAccountEntitlements(
  db: SupabaseClient,
  accountId: string,
): Promise<Entitlements> {
  const { data: sub } = await db
    .from('subscriptions')
    .select('status, plan_id, trial_ends_at, current_period_end, ai_messages_used, cycle_reset_at')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!sub) {
    return resolveEntitlements(
      { status: 'canceled', plan_id: 'trial', trial_ends_at: null, current_period_end: null, ai_messages_used: 0, cycle_reset_at: new Date().toISOString() },
      FALLBACK_PLAN,
    )
  }

  const { data: plan } = await db
    .from('plans')
    .select('max_numbers, max_contacts, max_ai_messages')
    .eq('id', sub.plan_id)
    .maybeSingle()

  return resolveEntitlements(sub as SubscriptionRow, (plan as PlanLimits) ?? FALLBACK_PLAN)
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/billing/quota.test.ts`.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + eslint on the four files.

- [ ] **Step 6: Concurrency check against real Postgres (MCP)** — prove the function caps under parallel-ish load. Run (MCP `execute_sql`) against `raqfuattunokpbozdhkc`:

```sql
-- set a throwaway account's used near a tiny effective limit using the trial plan (50):
update subscriptions set ai_messages_used = 49, cycle_reset_at = now() + interval '30 days',
  status='trialing', trial_ends_at = now() + interval '7 days'
  where account_id = (select id from accounts limit 1);
-- two consumes: first succeeds (→0 remaining), second must RAISE ai_quota_exceeded
select consume_ai_message((select id from accounts limit 1)); -- expect 0
do $$ begin
  perform consume_ai_message((select id from accounts limit 1));
  raise exception 'SHOULD HAVE BLOCKED';
exception when sqlstate 'P0001' then raise notice 'correctly blocked: %', sqlerrm;
end $$;
-- reset
update subscriptions set ai_messages_used = 0 where account_id = (select id from accounts limit 1);
```
Expected: first returns `0`; the `do` block prints `correctly blocked: ai_quota_exceeded`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing/quota.ts src/lib/billing/quota.test.ts src/lib/billing/events.ts src/lib/billing/load-entitlements.ts
git commit -m "feat(billing): quota wrapper, events writer, entitlements loader"
```

---

## Task 5: Gateway adapter (interface + stub)

**Files:** Create `src/lib/billing/gateway/types.ts`, `stub.ts`, `index.ts`.

- [ ] **Step 1: Implement the three files** (no test — trivial stub; verified by tsc + factory default).

`types.ts`:
```ts
export interface BillingGateway {
  createCustomer(input: { accountId: string; name: string; email?: string }): Promise<{ customerId: string }>
  createSubscription(input: { customerId: string; planId: string; method: 'pix' | 'card' }): Promise<{ subscriptionId: string; checkoutUrl?: string }>
  cancelSubscription(subscriptionId: string): Promise<void>
  parseWebhook(req: Request): Promise<BillingWebhookEvent | null>
}
export type BillingWebhookEvent =
  | { type: 'subscription_active'; gatewaySubscriptionId: string; periodEnd: string }
  | { type: 'subscription_past_due'; gatewaySubscriptionId: string }
  | { type: 'subscription_canceled'; gatewaySubscriptionId: string }
```

`stub.ts`:
```ts
import type { BillingGateway } from './types'

/** Cycle-A no-op gateway: deterministic ids, no external calls. Real Asaas is Cycle B. */
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
```

`index.ts`:
```ts
import type { BillingGateway } from './types'
import { stubGateway } from './stub'

/** Factory by env. Cycle A defaults to the stub; Cycle B adds 'asaas'. */
export function getGateway(): BillingGateway {
  // (Cycle B will switch on process.env.BILLING_GATEWAY === 'asaas')
  return stubGateway
}
export type { BillingGateway, BillingWebhookEvent } from './types'
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` + eslint on the three files.

- [ ] **Step 3: Commit**

```bash
git add src/lib/billing/gateway
git commit -m "feat(billing): gateway interface + stub + factory"
```

---

## Task 6: Enforce dispatch + channel cap in routes

**Files:** Create `src/lib/billing/require-entitlement.ts`; modify `src/app/api/whatsapp/send/route.ts`, `src/app/api/whatsapp/broadcast/route.ts`, `src/app/api/channels/route.ts`.

- [ ] **Step 1: Implement `src/lib/billing/require-entitlement.ts`**

```ts
import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccountEntitlements } from './load-entitlements'
import { billingErrorResponse } from './errors'

/**
 * Returns a billing error response if the account can't dispatch, else null.
 * Routes: `const blocked = await requireDispatch(db, accountId); if (blocked) return blocked;`
 */
export async function requireDispatch(
  db: SupabaseClient,
  accountId: string,
): Promise<NextResponse | null> {
  const ent = await getAccountEntitlements(db, accountId)
  if (!ent.canDispatch) return billingErrorResponse('billing_blocked')
  return null
}
```

- [ ] **Step 2: Gate the send route** — in `src/app/api/whatsapp/send/route.ts`, after the existing auth/account resolution (it already has the account id + a service-role or RLS client) and BEFORE the actual send, add:

```ts
import { requireDispatch } from '@/lib/billing/require-entitlement'
// ... after resolving `accountId` and a db client (use the same one the route already has):
const blocked = await requireDispatch(db, accountId)
if (blocked) return blocked
```
Read the route first to use its real client variable + accountId. (If it uses `supabaseAdmin()`/the SSR client, pass that as `db`.)

- [ ] **Step 3: Gate the broadcast route** — same pattern in `src/app/api/whatsapp/broadcast/route.ts`: after auth/account, before enqueuing/sending, `const blocked = await requireDispatch(db, accountId); if (blocked) return blocked;`.

- [ ] **Step 4: Channel cap** — in `src/app/api/channels/route.ts` POST handler, after `requireRole('admin')` gives `{ supabase, accountId }` and after the existing validation but BEFORE the insert of a NEW channel (not the update path), add:

```ts
import { getAccountEntitlements } from '@/lib/billing/load-entitlements'
import { billingErrorResponse } from '@/lib/billing/errors'
import { recordBillingEvent } from '@/lib/billing/events'
import { supabaseAdmin } from '@/lib/flows/admin-client'
// ... in the branch that INSERTs a brand-new channel (the `else` of the `claimed` check):
const ent = await getAccountEntitlements(supabase, accountId)
const { count } = await supabase.from('channels').select('id', { count: 'exact', head: true })
if (!ent.canDispatch) return billingErrorResponse('billing_blocked')
if ((count ?? 0) >= ent.limits.max_numbers) {
  await recordBillingEvent(supabaseAdmin(), accountId, 'channel_limit_reached', { limit: ent.limits.max_numbers })
  return billingErrorResponse('channel_limit_reached')
}
```
(Apply only to the create-new path; re-saving an existing instance must NOT be capped.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit`, eslint on the four files, and `npm run build` compiles + typechecks (the `/forgot-password` prerender error from missing local `NEXT_PUBLIC_SUPABASE_URL` is environmental, not a code failure).

- [ ] **Step 6: Commit**

```bash
git add src/lib/billing/require-entitlement.ts "src/app/api/whatsapp/send/route.ts" "src/app/api/whatsapp/broadcast/route.ts" "src/app/api/channels/route.ts"
git commit -m "feat(billing): enforce dispatch gate + channel cap in routes"
```

---

## Task 7: Enforce AI quota in the SDR worker

**Files:** Modify `src/worker/sdr-worker.ts`.

This is integration glue over the tested `consumeAiMessageOrThrow`; verified by tsc + eslint + boot.

- [ ] **Step 1: Read `src/worker/sdr-worker.ts`** to find `handleJob` — specifically the point AFTER `decideFromContext` returns a `reply`/`handoff`/`noop` decision and BEFORE `executeDecision` sends. The quota must be consumed only when an actual billable AI reply is about to be sent (decision.action === 'reply').

- [ ] **Step 2: Add the import + the consume gate** — add imports:

```ts
import { consumeAiMessageOrThrow } from '@/lib/billing/quota'
import { BillingError } from '@/lib/billing/errors'
import { recordBillingEvent } from '@/lib/billing/events'
```

In `handleJob`, replace the existing `await executeDecision(execDeps, decision, ctx)` call site so a reply first consumes quota:

```ts
    if (decision.action === 'reply') {
      try {
        await consumeAiMessageOrThrow(supabaseAdmin(), ctx.conversation.account_id)
      } catch (err) {
        if (err instanceof BillingError) {
          await recordBillingEvent(supabaseAdmin(), ctx.conversation.account_id, 'ai_quota_blocked', {
            code: err.code, conversation_id: conversationId,
          })
          await supabaseAdmin().from('sdr_runs').insert({
            account_id: ctx.conversation.account_id,
            conversation_id: ctx.conversation.id,
            broadcast_id: ctx.conversation.broadcast_id,
            inbound_message_ids: [],
            action: 'noop',
            error: `billing: ${err.code}`,
          })
          console.log(`[sdr-worker] ${conversationId} → blocked (${err.code})`)
          return
        }
        throw err
      }
    }
    await executeDecision(execDeps, decision, ctx)
```
(Keep the rest of `handleJob` — the existing follow-up scheduling after `executeDecision` — unchanged.)

- [ ] **Step 3: Verify** — `npx tsc --noEmit`, `npx eslint src/worker/sdr-worker.ts`, and a boot smoke-check:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co SUPABASE_SERVICE_ROLE_KEY=fake REDIS_URL=redis://localhost:6399 npx tsx src/worker/sdr-worker.ts > /tmp/billing-worker-boot.log 2>&1 &
```
Wait ~6s, `cat /tmp/billing-worker-boot.log`, then `pkill -f "tsx src/worker/sdr-worker.ts"`. Expect the import graph to load (Redis ECONNREFUSED lines are fine); no module/TypeError.

- [ ] **Step 4: Commit**

```bash
git add src/worker/sdr-worker.ts
git commit -m "feat(billing): SDR worker consumes AI quota (atomic) + blocks when exhausted"
```

---

## Task 8: Billing UI (settings section + banner)

**Files:** Create `src/components/settings/billing-settings.tsx`, `src/components/billing/billing-banner.tsx`; modify `src/components/settings/settings-sections.ts` + the settings page panel map; mount the banner in the dashboard shell.

- [ ] **Step 1: Read `src/components/settings/settings-sections.ts`** and the settings page (`src/app/(dashboard)/settings/page.tsx`) panel map to learn the exact `SettingsSection` union + how a section's panel is wired, then add a `billing` section: extend the `SettingsSection` type/array with `'billing'`, add `billing: { id: 'billing', label: 'Plano & cobrança', icon: CreditCard, group: 'workspace' }` to the meta map, and render `<BillingSettings />` for it in the page's `panel` record.

- [ ] **Step 2: Implement `src/components/settings/billing-settings.tsx`** — a client component that fetches the subscription + plan + live counts and shows plan, usage bars, trial days, and a placeholder subscribe button:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from '@/lib/billing/entitlements';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface View { plan: PlanLimits & { id: string; name: string }; sub: SubscriptionRow; numbers: number; contacts: number }

function Bar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">{used.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full">
        <div className={pct >= 100 ? 'bg-red-500 h-full' : 'bg-primary h-full'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BillingSettings() {
  const { accountId } = useAuth();
  const [v, setV] = useState<View | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    void (async () => {
      const { data: sub } = await supabase.from('subscriptions')
        .select('status, plan_id, trial_ends_at, current_period_end, ai_messages_used, cycle_reset_at')
        .eq('account_id', accountId).maybeSingle();
      if (!sub) return;
      const { data: plan } = await supabase.from('plans')
        .select('id, name, max_numbers, max_contacts, max_ai_messages').eq('id', sub.plan_id).maybeSingle();
      const { count: numbers } = await supabase.from('channels').select('id', { count: 'exact', head: true });
      const { count: contacts } = await supabase.from('contacts').select('id', { count: 'exact', head: true });
      if (plan) setV({ plan: plan as View['plan'], sub: sub as SubscriptionRow, numbers: numbers ?? 0, contacts: contacts ?? 0 });
    })();
  }, [accountId]);

  if (!v) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const ent = resolveEntitlements(v.sub, v.plan);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Plano & cobrança</h2>
        <p className="text-sm text-muted-foreground">
          Plano atual: <strong className="text-foreground">{v.plan.name}</strong>
          {ent.trialDaysLeft !== null && ` · trial: ${ent.trialDaysLeft} dia(s) restante(s)`}
          {ent.blocked && ' · bloqueado'}
        </p>
      </div>
      <div className="border-border bg-card space-y-3 rounded-xl border p-5">
        <Bar label="Números conectados" used={v.numbers} max={v.plan.max_numbers} />
        <Bar label="Contatos" used={v.contacts} max={v.plan.max_contacts} />
        <Bar label="Mensagens de IA (ciclo)" used={ent.aiUsed} max={v.plan.max_ai_messages} />
      </div>
      <Button onClick={() => toast.info('Checkout em breve.')}>Assinar / Fazer upgrade</Button>
    </div>
  );
}
```

- [ ] **Step 3: Implement `src/components/billing/billing-banner.tsx`** — a client banner shown when trial is ending soon or the account is blocked:

```tsx
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from '@/lib/billing/entitlements';
import { AlertTriangle } from 'lucide-react';

export function BillingBanner() {
  const { accountId } = useAuth();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    void (async () => {
      const { data: sub } = await supabase.from('subscriptions')
        .select('status, plan_id, trial_ends_at, current_period_end, ai_messages_used, cycle_reset_at')
        .eq('account_id', accountId).maybeSingle();
      if (!sub) return;
      const { data: plan } = await supabase.from('plans')
        .select('max_numbers, max_contacts, max_ai_messages').eq('id', sub.plan_id).maybeSingle();
      const ent = resolveEntitlements(sub as SubscriptionRow, (plan as PlanLimits) ?? { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 });
      if (ent.blocked) setMsg('Sua conta está bloqueada — assine para voltar a disparar.');
      else if (ent.trialDaysLeft !== null && ent.trialDaysLeft <= 2) setMsg(`Seu teste termina em ${ent.trialDaysLeft} dia(s). Assine para continuar.`);
      else setMsg(null);
    })();
  }, [accountId]);

  if (!msg) return null;
  return (
    <Link href="/settings?tab=billing" className="flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-400 hover:bg-amber-500/20">
      <AlertTriangle className="h-4 w-4" />
      {msg}
    </Link>
  );
}
```

- [ ] **Step 4: Surface the contact-limit error in the contacts UI** — the
  `enforce_contact_limit` trigger RAISEs `contact_limit_reached`; the client
  must catch it and show a friendly message (the DB enforces; the UI explains).
  - In `src/components/contacts/import-modal.tsx` `handleImport`, where a chunk
    insert returns an error, detect it and stop with a clear toast:
    ```ts
    if (error && String(error.message).includes('contact_limit_reached')) {
      toast.error('Limite de contatos do plano atingido — faça upgrade para importar mais.');
      break; // stop importing further chunks
    }
    ```
  - In `src/components/contacts/contact-form.tsx` (or wherever a single contact
    is created), wrap the insert and, on the same error, `toast.error('Limite de contatos do plano atingido. Faça upgrade para adicionar mais.')` instead of the generic failure.
  Note: the `billing_events` `contact_limit_reached` row is **not** written here
  — a client-side insert blocked by the trigger aborts its transaction, so an
  audit insert in the same path would roll back; that event type stays reserved
  (like `ai_quota_consumed`/`subscription_status_changed`, which Cycle B emits).
  **Cycle A actually emits:** `trial_started` (accounts trigger), `ai_quota_blocked` (worker), `channel_limit_reached` (channel route).

- [ ] **Step 5: Mount the banner** — render `<BillingBanner />` at the top of the dashboard shell layout (`src/app/(dashboard)/layout.tsx` or the equivalent shell that wraps the pages). Read that file and place it above the page content, like the inbox's WhatsApp banner pattern.

- [ ] **Step 6: Verify** — `npx tsc --noEmit`, eslint on the new/changed files, `npm run build` compiles + typechecks.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/billing-settings.tsx src/components/billing/billing-banner.tsx src/components/settings/settings-sections.ts "src/app/(dashboard)/settings/page.tsx" "src/app/(dashboard)/layout.tsx" src/components/contacts/import-modal.tsx src/components/contacts/contact-form.tsx
git commit -m "feat(billing): settings plan/usage view + trial/blocked banner"
```

---

## Task 9: Full verification

- [ ] **Step 1: Full suite** — `npx vitest run`. Expected: all pass except the 2 known pre-existing `date-utils` `mondayIndex` timezone failures.
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.
- [ ] **Step 3: Lint** — `npx eslint src/lib/billing src/components/billing src/components/settings/billing-settings.tsx "src/app/api/whatsapp/send" "src/app/api/whatsapp/broadcast" "src/app/api/channels" src/worker/sdr-worker.ts` → clean.
- [ ] **Step 4: Build** — `npm run build` compiles + passes TypeScript (ignore the environmental `/forgot-password` prerender error).
- [ ] **Step 5: Push** — `git push origin main`.

---

## Acceptance criteria (verify before done)

- Entitlements tested across trialing-active, trial-expired (time only), past_due, canceled, AI-quota-full, lazy reset (Task 2).
- AI quota cannot exceed the limit under concurrency — `consume_ai_message`'s `FOR UPDATE` + atomic update proven via the MCP block in Task 4 Step 6.
- New accounts auto-get a trialing subscription (accounts trigger); existing accounts backfilled (Task 1 Step 3 verify).
- Send/broadcast/SDR block when billing inactive (Tasks 6, 7).
- Contacts (trigger) and channels (route) respect limits.
- UI shows plan, usage bars, and a trial/blocked banner (Task 8).

## Post-merge (owner)

Redeploy **both** `zenith-sender` (web — routes + UI) and `zenith-worker` (the SDR quota gate). No new env. Cycle B (Asaas + checkout + webhook) is the next spec.
