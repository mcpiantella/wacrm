-- ============================================================
-- 028_channels.sql — Multi-number, dual-provider WhatsApp channels
--
-- wacrm ships with ONE Cloud API number per account
-- (`whatsapp_config`, UNIQUE(account_id)). Zenith needs:
--
--   * MANY numbers per account, and
--   * TWO providers side by side —
--       'cloud'      = WhatsApp Cloud API (Meta, official)
--       'evolution'  = Evolution API (unofficial)
--
-- This migration introduces a generalised `channels` table that
-- supersedes `whatsapp_config`, and wires `conversations` /
-- `broadcasts` to the specific channel they belong to.
--
-- What this migration does
--   1. Creates `channels` — N rows per account, one per WhatsApp
--      number, tagged by `provider`.
--   2. Enforces `UNIQUE(provider, identifier)` GLOBALLY. `identifier`
--      is the inbound routing key (Cloud: phone_number_id; Evolution:
--      instance name). This is the multi-provider generalisation of
--      migration 013's `UNIQUE(phone_number_id)` — it guarantees an
--      inbound event routes to exactly one channel, across all
--      accounts, so the webhook's `.single()` lookup is safe.
--   3. Stores provider metadata in `config` (non-secret) and secrets
--      in `credentials` (ciphertext only — encrypted at the app layer
--      with ENCRYPTION_KEY, exactly like whatsapp_config.access_token).
--   4. RLS: settings-class. Members read; admins+ write — same policy
--      shape as whatsapp_config in 017.
--   5. Adds nullable `channel_id` to `conversations` and `broadcasts`
--      (ON DELETE SET NULL: removing a number must not destroy history
--      or sent-broadcast records).
--   6. Backfills one 'cloud' channel per existing `whatsapp_config`
--      row, copying the already-encrypted access_token verbatim.
--
-- What this migration does NOT do
--   - It does NOT drop `whatsapp_config`. App code still reads it
--     until the channel abstraction (S5/S6) lands; dropping it now
--     would break the running app. A later cleanup migration removes
--     it once nothing references it.
-- ============================================================

-- ── 1. channels table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- creator/agent for audit; not used for tenancy isolation.
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  provider      TEXT NOT NULL CHECK (provider IN ('cloud', 'evolution')),
  -- Inbound routing key. Cloud: phone_number_id. Evolution: instance name.
  identifier    TEXT NOT NULL,

  display_name  TEXT,                 -- user-facing label ("Vendas SP")
  phone_e164    TEXT,                 -- the actual WhatsApp number, for display

  status        TEXT NOT NULL DEFAULT 'disconnected'
                CHECK (status IN ('connected', 'disconnected', 'error')),

  -- Non-secret provider metadata:
  --   cloud      -> { waba_id, verify_token, registered_at, ... }
  --   evolution  -> { base_url, ... }
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Secrets, CIPHERTEXT ONLY (app encrypts with ENCRYPTION_KEY):
  --   cloud      -> { access_token }
  --   evolution  -> { api_key }
  credentials   JSONB NOT NULL DEFAULT '{}'::jsonb,

  connected_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Global routing uniqueness (see header note 2).
  CONSTRAINT channels_provider_identifier_key UNIQUE (provider, identifier)
);

CREATE INDEX IF NOT EXISTS idx_channels_account  ON channels (account_id);
CREATE INDEX IF NOT EXISTS idx_channels_provider ON channels (provider, identifier);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. RLS (settings-class: member reads, admin+ writes) ─────
DROP POLICY IF EXISTS channels_select ON channels;
DROP POLICY IF EXISTS channels_insert ON channels;
DROP POLICY IF EXISTS channels_update ON channels;
DROP POLICY IF EXISTS channels_delete ON channels;

CREATE POLICY channels_select ON channels FOR SELECT USING (is_account_member(account_id));
CREATE POLICY channels_insert ON channels FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY channels_update ON channels FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY channels_delete ON channels FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ── 3. channel_id on conversations / broadcasts ──────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations (channel_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_channel    ON broadcasts (channel_id);

-- ── 4. Backfill existing Cloud configs into channels ─────────
-- One 'cloud' channel per whatsapp_config row. access_token is
-- already ciphertext, so it is copied verbatim. Idempotent via the
-- UNIQUE(provider, identifier) conflict guard.
INSERT INTO channels (account_id, user_id, provider, identifier, status, config, credentials, connected_at, created_at)
SELECT
  wc.account_id,
  wc.user_id,
  'cloud',
  wc.phone_number_id,
  COALESCE(wc.status, 'disconnected'),
  jsonb_strip_nulls(jsonb_build_object(
    'waba_id',            wc.waba_id,
    'verify_token',       wc.verify_token,
    'registered_at',      wc.registered_at,
    'subscribed_apps_at', wc.subscribed_apps_at
  )),
  jsonb_build_object('access_token', wc.access_token),
  wc.connected_at,
  COALESCE(wc.created_at, now())
FROM whatsapp_config wc
ON CONFLICT (provider, identifier) DO NOTHING;
