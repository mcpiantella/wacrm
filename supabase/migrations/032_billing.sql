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
