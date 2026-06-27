-- ============================================================
-- 030_sdr_followup.sql — SDR follow-up (re-engagement) support.
--
-- Adds the per-campaign follow-up knobs and two new sdr_runs.action
-- values ('followup', 'cold'). No conversation-level counter: the
-- attempt rides in the BullMQ job and history is in sdr_runs.
-- ============================================================

ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS follow_up_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS follow_up_delays INTEGER[] NOT NULL DEFAULT '{180,1440}';
ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS cold_tag TEXT NOT NULL DEFAULT 'lead-frio';

-- Widen the run action enum to cover the follow-up + cold-close runs.
ALTER TABLE sdr_runs DROP CONSTRAINT IF EXISTS sdr_runs_action_check;
ALTER TABLE sdr_runs
  ADD CONSTRAINT sdr_runs_action_check
  CHECK (action IN ('reply', 'handoff', 'noop', 'error', 'followup', 'cold'));
