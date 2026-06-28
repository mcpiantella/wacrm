-- ============================================================
-- 031_tags_unique_name.sql — enforce one tag per (account, name).
--
-- The SDR cold-close path creates a `lead-frio` tag automatically for
-- every cold lead via a non-atomic find-or-create. Without a uniqueness
-- guarantee, concurrent cold-closes for the same account could insert
-- duplicate tags. This adds a case-insensitive unique index; the app's
-- find-or-create then treats a unique violation as "lost the race" and
-- re-selects the surviving tag.
--
-- Defensive de-dup first (collapse any existing case-insensitive dups to
-- the oldest row, repointing contact_tags) so the index can be created on
-- any environment.
-- ============================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT account_id,
           lower(name) AS lname,
           (array_agg(id ORDER BY created_at NULLS FIRST, id))[1] AS survivor,
           array_agg(id ORDER BY created_at NULLS FIRST, id) AS ids
    FROM tags
    GROUP BY account_id, lower(name)
    HAVING count(*) > 1
  LOOP
    -- Repoint contact_tags to the survivor, skipping pairs that already exist.
    UPDATE contact_tags ct
      SET tag_id = r.survivor
      WHERE ct.tag_id = ANY(r.ids) AND ct.tag_id <> r.survivor
        AND NOT EXISTS (
          SELECT 1 FROM contact_tags x
          WHERE x.contact_id = ct.contact_id AND x.tag_id = r.survivor
        );
    DELETE FROM contact_tags ct WHERE ct.tag_id = ANY(r.ids) AND ct.tag_id <> r.survivor;
    DELETE FROM tags t WHERE t.id = ANY(r.ids) AND t.id <> r.survivor;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_lower_name
  ON tags (account_id, lower(name));
