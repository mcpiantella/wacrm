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
