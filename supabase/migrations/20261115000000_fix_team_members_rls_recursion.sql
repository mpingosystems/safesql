-- Sprint 9.6-RLS — fix "infinite recursion detected in policy for relation
-- team_members" (Postgres 42P17).
--
-- MANUAL APPLY: paste into the Supabase SQL Editor and run. Nothing here is run
-- automatically.
--
-- WHAT WENT WRONG
-- The team_members SELECT policy "team members read members" subqueried
-- team_members, so evaluating it re-applied itself. Every other policy that
-- subqueried team_members (15 more, on 10 tables) tripped the same policy, so
-- any signed-in read of those tables failed — including the RETURNING read on
-- POST /rest/v1/validations. It went unnoticed because browser auth was broken
-- from 2026-08-07 to 2026-11-15 and unit tests mock Supabase.
--
-- THE FIX
-- Membership lookups move into SECURITY DEFINER helpers in a `private` schema
-- (not exposed to the API). They run as their owner (postgres, BYPASSRLS), so
-- reading team_members inside them does not re-enter team_members RLS. They
-- only ever return the caller's own memberships (clerk_user_id = JWT sub), which
-- is exactly what each old subquery selected.
--
-- All 16 policies keep their names, commands and expressions; the only changes
-- are (a) the team_members subquery becomes a helper call and (b) TO
-- authenticated (owner-approved 2026-11-15). For anon the old expressions could
-- never be true (no `sub`/`email` claim, clerk_user_id is NOT NULL), so (b) does
-- not change who can see what; it stops anon queries from erroring on a helper
-- anon may not execute.
--
-- Untouched: "users own validations" (owner path), "user inserts own
-- membership", "founder creates team", "invitees accept own invitation", and
-- every policy not listed below.
--
-- Rollback: supabase/verify/9.6-rls-rollback.sql. Checks: supabase/verify/9.6-rls-check.sql.
-- Idempotent and safe to re-run.

BEGIN;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS private;

-- Teams the signed-in user belongs to.
CREATE OR REPLACE FUNCTION private.my_team_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT tm.team_id FROM public.team_members tm
   WHERE tm.clerk_user_id = (auth.jwt() ->> 'sub')
$$;

-- Teams where the signed-in user holds one of the given roles.
CREATE OR REPLACE FUNCTION private.my_team_ids(roles text[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT tm.team_id FROM public.team_members tm
   WHERE tm.clerk_user_id = (auth.jwt() ->> 'sub')
     AND tm.role = ANY (roles)
$$;

-- Teams the signed-in user has joined (joined_at set). Used by validations.
CREATE OR REPLACE FUNCTION private.my_joined_team_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT tm.team_id FROM public.team_members tm
   WHERE tm.clerk_user_id = (auth.jwt() ->> 'sub')
     AND tm.joined_at IS NOT NULL
$$;

REVOKE ALL ON SCHEMA private FROM public, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

REVOKE EXECUTE ON FUNCTION private.my_team_ids()          FROM public, anon;
REVOKE EXECUTE ON FUNCTION private.my_team_ids(text[])    FROM public, anon;
REVOKE EXECUTE ON FUNCTION private.my_joined_team_ids()   FROM public, anon;
GRANT  EXECUTE ON FUNCTION private.my_team_ids()          TO authenticated;
GRANT  EXECUTE ON FUNCTION private.my_team_ids(text[])    TO authenticated;
GRANT  EXECUTE ON FUNCTION private.my_joined_team_ids()   TO authenticated;

-- ── 1. approval_policies ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "approval_policies_team_read" ON public.approval_policies;
CREATE POLICY "approval_policies_team_read" ON public.approval_policies
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 2–3. approval_requests ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "approval_requests_requester_insert" ON public.approval_requests;
CREATE POLICY "approval_requests_requester_insert" ON public.approval_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requester_id IN (SELECT id FROM public.users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
    AND team_id IN (SELECT private.my_team_ids())
  );

DROP POLICY IF EXISTS "approval_requests_team_read" ON public.approval_requests;
CREATE POLICY "approval_requests_team_read" ON public.approval_requests
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 4. audit_events ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "audit_events_team_read" ON public.audit_events;
CREATE POLICY "audit_events_team_read" ON public.audit_events
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 5. audit_log ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "audit_log_team_read" ON public.audit_log;
CREATE POLICY "audit_log_team_read" ON public.audit_log
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager', 'auditor'])));

-- ── 6. custom_rules ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "custom_rules_team_read" ON public.custom_rules;
CREATE POLICY "custom_rules_team_read" ON public.custom_rules
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 7. evidence_bundles ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "evidence_bundles_team_read" ON public.evidence_bundles;
CREATE POLICY "evidence_bundles_team_read" ON public.evidence_bundles
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 8. saved_queries ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "team members read shared queries" ON public.saved_queries;
CREATE POLICY "team members read shared queries" ON public.saved_queries
  FOR SELECT TO authenticated
  USING (
    is_team_shared = true
    AND team_id IN (SELECT private.my_team_ids())
  );

-- ── 9–10. team_invitations ──────────────────────────────────────────────────
-- Email branch kept word for word from the live policy.
-- OPEN ITEM (not 9.6-RLS): this branch needs an 'email' claim in the session
-- JWT, which Clerk's default session token may not include. Check when the
-- team-invite flow is tested.
DROP POLICY IF EXISTS "invitees read own invitation" ON public.team_invitations;
CREATE POLICY "invitees read own invitation" ON public.team_invitations
  FOR SELECT TO authenticated
  USING (
    (email = (auth.jwt() ->> 'email'))
    OR team_id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager']))
  );

DROP POLICY IF EXISTS "managers create invitations" ON public.team_invitations;
CREATE POLICY "managers create invitations" ON public.team_invitations
  FOR INSERT TO authenticated
  WITH CHECK (team_id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager'])));

-- ── 11–13. team_members ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers delete members" ON public.team_members;
CREATE POLICY "managers delete members" ON public.team_members
  FOR DELETE TO authenticated
  USING (team_id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager'])));

DROP POLICY IF EXISTS "managers manage members" ON public.team_members;
CREATE POLICY "managers manage members" ON public.team_members
  FOR UPDATE TO authenticated
  USING (team_id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager'])));

-- The recursive one.
DROP POLICY IF EXISTS "team members read members" ON public.team_members;
CREATE POLICY "team members read members" ON public.team_members
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_team_ids()));

-- ── 14–15. teams ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "team managers update team" ON public.teams;
CREATE POLICY "team managers update team" ON public.teams
  FOR UPDATE TO authenticated
  USING (id IN (SELECT private.my_team_ids(ARRAY['owner', 'manager'])));

DROP POLICY IF EXISTS "team members read team" ON public.teams;
CREATE POLICY "team members read team" ON public.teams
  FOR SELECT TO authenticated
  USING (id IN (SELECT private.my_team_ids()));

-- ── 16. validations ─────────────────────────────────────────────────────────
-- Repo-only name from 20260826*; not live. Dropped so a re-run of an older
-- migration's intent cannot leave a recursive policy behind.
DROP POLICY IF EXISTS "validations_owner_or_team_read" ON public.validations;

DROP POLICY IF EXISTS "Team members can view team validations" ON public.validations;
CREATE POLICY "Team members can view team validations" ON public.validations
  FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.my_joined_team_ids()));

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — the full check set is supabase/verify/9.6-rls-check.sql. Quick form:
-- ═══════════════════════════════════════════════════════════════════════════
--   -- Expect 0 rows: no policy reads team_members directly any more.
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (coalesce(qual, '') ~* 'from\s+(public\.)?team_members'
--        OR coalesce(with_check, '') ~* 'from\s+(public\.)?team_members');
--
--   -- Expect 3 rows, prosecdef = true, search_path=''.
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--          p.prosecdef, p.provolatile, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'private'
--      AND p.proname IN ('my_team_ids', 'my_joined_team_ids');
