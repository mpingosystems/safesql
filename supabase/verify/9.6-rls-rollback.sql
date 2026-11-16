-- Sprint 9.6-RLS — ROLLBACK. Use ONLY if
-- 20261115000000_fix_team_members_rls_recursion.sql misbehaves.
--
-- ⚠️ This restores the pre-fix policies, which bring back the 42P17
-- "infinite recursion" error for signed-in users. It is a way back to the
-- known state, not a fix.
--
-- Expressions mirror the pre-fix live pg_policies output saved 2026-11-15
-- before any change. Checked policy by policy against it:
-- name, command, roles {public}, qual and with_check match once whitespace,
-- ::text casts and the `public.` prefix are normalised.
--
-- Roles are restored to {public} (no TO clause), as live before the fix.
-- validations_owner_or_team_read is NOT recreated: it was not live.
-- Idempotent. MANUAL APPLY in the Supabase SQL Editor.

BEGIN;

-- 1
DROP POLICY IF EXISTS "approval_policies_team_read" ON public.approval_policies;
CREATE POLICY "approval_policies_team_read" ON public.approval_policies
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 2
DROP POLICY IF EXISTS "approval_requests_requester_insert" ON public.approval_requests;
CREATE POLICY "approval_requests_requester_insert" ON public.approval_requests
  FOR INSERT
  WITH CHECK ((requester_id IN ( SELECT users.id
     FROM public.users
    WHERE (users.clerk_user_id = (auth.jwt() ->> 'sub')))) AND (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub')))));

-- 3
DROP POLICY IF EXISTS "approval_requests_team_read" ON public.approval_requests;
CREATE POLICY "approval_requests_team_read" ON public.approval_requests
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 4
DROP POLICY IF EXISTS "audit_events_team_read" ON public.audit_events;
CREATE POLICY "audit_events_team_read" ON public.audit_events
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 5
DROP POLICY IF EXISTS "audit_log_team_read" ON public.audit_log;
CREATE POLICY "audit_log_team_read" ON public.audit_log
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE ((team_members.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members.role = ANY (ARRAY['owner', 'manager', 'auditor'])))));

-- 6
DROP POLICY IF EXISTS "custom_rules_team_read" ON public.custom_rules;
CREATE POLICY "custom_rules_team_read" ON public.custom_rules
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 7
DROP POLICY IF EXISTS "evidence_bundles_team_read" ON public.evidence_bundles;
CREATE POLICY "evidence_bundles_team_read" ON public.evidence_bundles
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 8
DROP POLICY IF EXISTS "team members read shared queries" ON public.saved_queries;
CREATE POLICY "team members read shared queries" ON public.saved_queries
  FOR SELECT
  USING ((is_team_shared = true) AND (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub')))));

-- 9 (live form: email branch, not the repo's invitation-token branch)
DROP POLICY IF EXISTS "invitees read own invitation" ON public.team_invitations;
CREATE POLICY "invitees read own invitation" ON public.team_invitations
  FOR SELECT
  USING ((email = (auth.jwt() ->> 'email')) OR (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE ((team_members.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members.role = ANY (ARRAY['owner', 'manager']))))));

-- 10
DROP POLICY IF EXISTS "managers create invitations" ON public.team_invitations;
CREATE POLICY "managers create invitations" ON public.team_invitations
  FOR INSERT
  WITH CHECK (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE ((team_members.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members.role = ANY (ARRAY['owner', 'manager'])))));

-- 11 (team_members_1 is the alias Postgres generated for the inner team_members)
DROP POLICY IF EXISTS "managers delete members" ON public.team_members;
CREATE POLICY "managers delete members" ON public.team_members
  FOR DELETE
  USING (team_id IN ( SELECT team_members_1.team_id
     FROM public.team_members team_members_1
    WHERE ((team_members_1.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members_1.role = ANY (ARRAY['owner', 'manager'])))));

-- 12
DROP POLICY IF EXISTS "managers manage members" ON public.team_members;
CREATE POLICY "managers manage members" ON public.team_members
  FOR UPDATE
  USING (team_id IN ( SELECT team_members_1.team_id
     FROM public.team_members team_members_1
    WHERE ((team_members_1.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members_1.role = ANY (ARRAY['owner', 'manager'])))));

-- 13 (the recursive one)
DROP POLICY IF EXISTS "team members read members" ON public.team_members;
CREATE POLICY "team members read members" ON public.team_members
  FOR SELECT
  USING (team_id IN ( SELECT m2.team_id
     FROM public.team_members m2
    WHERE (m2.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 14
DROP POLICY IF EXISTS "team managers update team" ON public.teams;
CREATE POLICY "team managers update team" ON public.teams
  FOR UPDATE
  USING (id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE ((team_members.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members.role = ANY (ARRAY['owner', 'manager'])))));

-- 15
DROP POLICY IF EXISTS "team members read team" ON public.teams;
CREATE POLICY "team members read team" ON public.teams
  FOR SELECT
  USING (id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE (team_members.clerk_user_id = (auth.jwt() ->> 'sub'))));

-- 16 (live form; joined_at check inside the subquery)
DROP POLICY IF EXISTS "Team members can view team validations" ON public.validations;
CREATE POLICY "Team members can view team validations" ON public.validations
  FOR SELECT
  USING (team_id IN ( SELECT team_members.team_id
     FROM public.team_members
    WHERE ((team_members.clerk_user_id = (auth.jwt() ->> 'sub')) AND (team_members.joined_at IS NOT NULL))));

-- Helpers: no policy references them any more, so these drop cleanly. No
-- CASCADE: if anything else was added to `private`, the schema drop fails and
-- the whole rollback stops (nothing is half-applied).
DROP FUNCTION IF EXISTS private.my_team_ids();
DROP FUNCTION IF EXISTS private.my_team_ids(text[]);
DROP FUNCTION IF EXISTS private.my_joined_team_ids();
DROP SCHEMA IF EXISTS private;

COMMIT;
