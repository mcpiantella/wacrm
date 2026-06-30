# Billing Cycle B — Sandbox Checklist (Asaas)

Operator runbook to validate Cycle B end-to-end in **Asaas sandbox** before flipping `BILLING_GATEWAY=asaas` in production. Cycle B ships dark: with `BILLING_GATEWAY` unset, the offline stub is used and none of this applies.

> **Why this exists:** the exact Asaas request/response shapes (the `/checkouts` path, the response url field, the webhook event names, the `customer` id shape) are best-effort in code and carry a `// verify against live Asaas docs` note. This checklist is where you confirm them against the real API before trusting it with money.

---

## 0. Prerequisites

- [ ] Asaas **sandbox** account created → grab the **API key** (Settings → Integrations → API key).
- [ ] Pick a strong random **webhook token** (any long secret string you choose).
- [ ] Migration `033_billing_checkout.sql` is applied to the target database. (Already applied to the shared Supabase project `raqfuattunokpbozdhkc`; for a fresh DB, apply it first.)
- [ ] A staging/sandbox deployment of `zenith-sender` (web) you can point at the sandbox — **do not test against prod env vars**.

## 1. Configure env (on the `zenith-sender` web service)

```env
BILLING_GATEWAY=asaas
ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3
ASAAS_API_KEY=<sandbox api key>
ASAAS_WEBHOOK_TOKEN=<the webhook token you chose>
```

- [ ] Redeploy `zenith-sender` after setting these.
- [ ] The **worker** (`zenith-worker`) needs migration 033 but **no Asaas env** — it only reads `allowed_model_keys`. Confirm it's on the same DB.

## 2. Register the webhook in Asaas

- [ ] Asaas sandbox → Settings → Webhooks → add: URL `https://<staging-web-host>/api/billing/webhook`.
- [ ] Set the webhook **access token** to the SAME value as `ASAAS_WEBHOOK_TOKEN`. (The route rejects mismatches and rejects an empty configured token — so this must match.)
- [ ] Subscribe at least to payment + subscription events.

## 3. Verify the API contract (do this FIRST — it's the riskiest assumption)

When you trigger the first checkout (step 4), capture the actual Asaas HTTP traffic / dashboard and confirm:

- [ ] The create-checkout endpoint really is `POST /v3/checkouts` (adapter: `src/lib/billing/gateway/asaas.ts` → `createCheckout`). If Asaas uses a different path/body, fix the adapter.
- [ ] The create-checkout **response** carries the hosted URL in `link` (adapter falls back to `url` / `checkoutUrl`). Confirm which field is real.
- [ ] The webhook **event names** match the sets in the adapter:
  - active: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`
  - past_due: `PAYMENT_OVERDUE`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`
  - canceled: `PAYMENT_REFUNDED`, `PAYMENT_DELETED`, `SUBSCRIPTION_DELETED`
- [ ] The webhook payload exposes `payment.subscription` (subscription id) and `payment.dueDate` (used for `current_period_end`). If the field names differ, fix `parseWebhook`.
- [ ] The webhook payload top-level `id` exists (used for idempotency dedupe).

## 4. Happy path — subscribe & activate

- [ ] In the app: **Settings → Plano & cobrança**, click **Assinar** on a paid plan (Starter/Pro/Business).
- [ ] You're redirected to the Asaas hosted checkout. Pay with an Asaas **sandbox test card**.
- [ ] After payment, you land back on `/settings?tab=billing`.

Verify in the DB:
```sql
-- a started row was created at click, then completed by the webhook:
select status, target_plan_id, gateway_checkout_id, gateway_subscription_id, completed_at
from billing_checkouts where account_id = '<acct>' order by created_at desc limit 3;
-- subscription moved to active + the new plan + a real period end:
select status, plan_id, current_period_end, gateway, gateway_subscription_id
from subscriptions where account_id = '<acct>';
-- the audit event:
select type, metadata, created_at from billing_events
where account_id = '<acct>' order by created_at desc limit 5;
-- the processed webhook id was recorded:
select * from billing_webhook_events order by received_at desc limit 5;
```
Expected: checkout `completed`; subscription `active` on the target plan; `subscription_status_changed` event; one `billing_webhook_events` row.

## 5. Idempotency — replay protection

- [ ] In Asaas, **re-send** the same `PAYMENT_CONFIRMED` event (most dashboards have a "resend webhook" button), OR observe Asaas's natural retry.
- [ ] Confirm NO duplicate state change: still one `billing_webhook_events` row for that `event_id`, subscription unchanged, no duplicate `subscription_status_changed` audit row for the replay.

## 6. Repeat-click protection

- [ ] Click **Assinar** twice quickly (within 30 min) for the same plan.
- [ ] Confirm only **one** `billing_checkouts` row with `status='started'` for that `(account, plan)`, and the second click returned the same `checkout_url` (no second Asaas checkout created).

## 7. Refund → canceled

- [ ] In Asaas sandbox, issue a **refund** on the confirmed payment.
- [ ] Confirm webhook `PAYMENT_REFUNDED` arrives and `subscriptions.status` → `canceled`.
- [ ] App shows the billing banner / blocked state (dispatch + SDR blocked by `resolveEntitlements`).

## 8. Chargeback → past_due

- [ ] Simulate a chargeback (`PAYMENT_CHARGEBACK_REQUESTED`) if the sandbox allows.
- [ ] Confirm `subscriptions.status` → `past_due` immediately.

## 9. Capture refused → past_due

- [ ] Trigger a failed capture (`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`) if reproducible.
- [ ] Confirm `subscriptions.status` → `past_due`.

## 10. Upgrade safety (CRITICAL)

- [ ] With an account already **active** on plan A, start a checkout to upgrade to plan B, then **abandon/cancel** the Asaas checkout (don't pay).
- [ ] Confirm the account is **still active on plan A** — `subscriptions.plan_id` did NOT move, `status` still `active`. (A `started` `billing_checkouts` row may linger; that's fine.)
- [ ] Only after a real `PAYMENT_CONFIRMED` for plan B should `plan_id` move to B.

## 11. Model allow-list (cost vector)

- [ ] On a **standard** plan, attempt to set a premium model via the API directly:
  ```bash
  curl -X PUT https://<host>/api/sdr/config -H 'content-type: application/json' \
    -H 'cookie: <authed session>' \
    -d '{"broadcast_id":"<id>","enabled":true,"model":"claude-sonnet-4-6", ...}'
  ```
  Expect **HTTP 400** `{ "error": { "code": "model_not_allowed" } }`.
- [ ] **Downgrade test:** manually set `sdr_configs.model='claude-sonnet-4-6'` in the DB, then trigger an SDR reply. Confirm the **worker logs** `model ... not allowed for account ...; using default` and the LLM call uses the default model (check `chatComplete` model in logs) — the worker re-validates at read-time, so a stale/patched premium model does NOT get billed.
- [ ] To allow premium on a custom plan: create a plan row with `is_custom=true` and `allowed_model_keys` including `premium_anthropic`, assign it via `subscriptions.plan_id`, and confirm the same config now saves and runs.

## 12. Sign-off & go-live

- [ ] All of the above pass.
- [ ] Switch env to **production** Asaas: `ASAAS_BASE_URL=https://api.asaas.com/v3`, prod `ASAAS_API_KEY`, prod `ASAAS_WEBHOOK_TOKEN`; register the prod webhook URL.
- [ ] Redeploy **both** `zenith-sender` (web) and `zenith-worker`.
- [ ] Keep the owner/test account on its manually-set `active`/`business` subscription (no checkout needed).

## Rollback

- [ ] Unset `BILLING_GATEWAY` (or set to anything other than `asaas`) and redeploy `zenith-sender`. The factory falls back to the offline stub; checkout/webhook become no-ops. No schema rollback needed — migration 033 is additive.

## Known follow-ups (deferred, non-blocking)

- `current_period_end` is written from Asaas `dueDate` (a date string) into a `TIMESTAMPTZ` (interpreted as UTC midnight). Align to a full timestamp if end-of-day precision matters.
- `billing_checkouts.gateway` is hard-coded `'asaas'` even under the stub (cosmetic).
- No route-level integration tests for the webhook/checkout endpoints (the pure mapper + services are unit-tested); add if desired.
