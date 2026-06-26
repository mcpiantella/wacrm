-- ============================================================
-- 027_platform_admins.sql — Platform-level super admin (Zenith)
--
-- The 017 account model isolates every tenant behind
-- `is_account_member()`. That is exactly what we want for
-- customers — but the platform operator (the SaaS owner) needs
-- read/write oversight across ALL accounts for support and
-- administration.
--
-- Rather than touch the ~76 RLS policies that route through
-- `is_account_member()`, we add the escape hatch in ONE place:
-- inside that function. A platform admin short-circuits the
-- membership check and is treated as a member of every account.
--
-- What this migration does
--   1. Creates a `private` schema, NOT exposed to the API. The
--      `authenticated` / `anon` roles get no access to it, so the
--      admin list and the check function are invisible to clients.
--   2. Creates `private.platform_admins(user_id)` — the allowlist.
--   3. Creates `private.is_platform_admin()` SECURITY DEFINER —
--      true iff the current `auth.uid()` is in that table.
--   4. Recreates `is_account_member()` with a leading
--      `private.is_platform_admin() OR ...` escape. The role
--      hierarchy and membership logic are otherwise unchanged.
--
-- Security notes
--   - `private` is revoked from `authenticated`/`anon` on purpose.
--     Clients never call `is_platform_admin()` directly; only the
--     SECURITY DEFINER `is_account_member()` (owned by postgres)
--     reaches into `private`. A non-admin user therefore behaves
--     EXACTLY as before this migration.
--   - To grant platform admin: INSERT a user_id into
--     `private.platform_admins`. Keep this list tiny.
-- ============================================================

-- 1. Private schema (hidden from PostgREST / clients)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM authenticated, anon;

-- 2. Allowlist table
CREATE TABLE IF NOT EXISTS private.platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Platform-admin check
CREATE OR REPLACE FUNCTION private.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.platform_admins pa
    WHERE pa.user_id = auth.uid()
  );
$$;

ALTER FUNCTION private.is_platform_admin() OWNER TO postgres;
-- No EXECUTE grant to authenticated/anon: only is_account_member
-- (SECURITY DEFINER, owned by postgres) calls this.

-- 4. Recreate is_account_member with the platform-admin escape.
--    Identical to 017 except for the leading short-circuit.
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT private.is_platform_admin() OR EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;
