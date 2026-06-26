-- ============================================================
-- 029_sdr.sql — In-app SDR (conversational LLM qualifier)
--
-- Foundation for the in-app SDR that replaces the n8n [ZG] SDR v5.0
-- workflow. Three pieces:
--
--   1. sdr_configs — the SDR behaviour, PER CAMPAIGN (1:1 with a
--      broadcast). enabled flag + system prompt + qualification
--      criteria + handoff keywords + debounce/turn limits.
--   2. conversations.sdr_status + conversations.broadcast_id — per
--      conversation runtime state, and the link to the campaign that
--      owns its SDR. broadcast_recipients tracks delivery (many per
--      contact, ambiguous); this explicit FK is the unambiguous
--      "which campaign drives the SDR for this thread" pointer, set
--      by the dispatch path when an SDR-enabled broadcast opens the
--      conversation.
--   3. sdr_runs — one row per SDR execution, for observability and
--      cost auditing. Written by the worker (service-role).
--
-- RLS: sdr_configs is settings-class (member reads; admin+ writes).
-- sdr_runs is member-read-only — inserts come from the worker via the
-- service-role client, which bypasses RLS, so no INSERT policy exists
-- for the authenticated role (a signed-in user can't forge run rows).
-- ============================================================

-- ── 1. sdr_configs (per broadcast/campaign) ──────────────────
CREATE TABLE IF NOT EXISTS sdr_configs (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id           UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  system_prompt          TEXT,
  qualification_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  model                  TEXT,
  handoff_keywords       TEXT[] NOT NULL DEFAULT '{}',
  max_turns              INTEGER NOT NULL DEFAULT 20 CHECK (max_turns BETWEEN 1 AND 200),
  debounce_seconds       INTEGER NOT NULL DEFAULT 12 CHECK (debounce_seconds BETWEEN 5 AND 60),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sdr_configs_broadcast_key UNIQUE (broadcast_id)
);

CREATE INDEX IF NOT EXISTS idx_sdr_configs_account ON sdr_configs (account_id);

ALTER TABLE sdr_configs ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON sdr_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sdr_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS sdr_configs_select ON sdr_configs;
DROP POLICY IF EXISTS sdr_configs_insert ON sdr_configs;
DROP POLICY IF EXISTS sdr_configs_update ON sdr_configs;
DROP POLICY IF EXISTS sdr_configs_delete ON sdr_configs;
CREATE POLICY sdr_configs_select ON sdr_configs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY sdr_configs_insert ON sdr_configs FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY sdr_configs_update ON sdr_configs FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY sdr_configs_delete ON sdr_configs FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ── 2. conversation SDR state + campaign link ────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sdr_status TEXT NOT NULL DEFAULT 'off'
    CHECK (sdr_status IN ('off', 'active', 'handoff'));
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES broadcasts(id) ON DELETE SET NULL;

-- Partial index: the worker/enqueue path only cares about active threads.
CREATE INDEX IF NOT EXISTS idx_conversations_sdr_active
  ON conversations (id) WHERE sdr_status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_broadcast
  ON conversations (broadcast_id);

-- ── 3. sdr_runs (execution log) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sdr_runs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  broadcast_id        UUID REFERENCES broadcasts(id) ON DELETE SET NULL,
  inbound_message_ids UUID[] NOT NULL DEFAULT '{}',
  transcript_in       TEXT,
  llm_output          JSONB,
  action              TEXT NOT NULL CHECK (action IN ('reply', 'handoff', 'noop', 'error')),
  reply_message_id    UUID,
  tokens              INTEGER,
  latency_ms          INTEGER,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sdr_runs_conversation ON sdr_runs (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sdr_runs_account ON sdr_runs (account_id, created_at DESC);

ALTER TABLE sdr_runs ENABLE ROW LEVEL SECURITY;

-- Member read-only. No INSERT/UPDATE/DELETE policy: the worker writes
-- via the service-role client (bypasses RLS); the dashboard never
-- mutates run rows, so a signed-in user cannot forge them.
DROP POLICY IF EXISTS sdr_runs_select ON sdr_runs;
CREATE POLICY sdr_runs_select ON sdr_runs FOR SELECT USING (is_account_member(account_id));
