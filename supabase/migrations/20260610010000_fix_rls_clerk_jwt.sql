-- Fix RLS to read the acting user from the Clerk JWT instead of a GUC.
--
-- The Sprint 9/10 tables (teams, team_members, team_invitations,
-- schema_connections, saved_queries, email_preferences) gated RLS on
--   current_setting('app.clerk_user_id', true)
-- which only works if some server layer runs `SET app.clerk_user_id = ...`
-- before each query. The browser talks to PostgREST directly with the Clerk
-- session JWT and never sets that GUC, so those policies matched nobody and
-- the features silently returned zero rows.
--
-- Now that Supabase trusts Clerk JWTs (JWKS at clerk.safesqlpro.dev), the
-- acting user is available as auth.jwt()->>'sub' (= clerk_user_id). This
-- migration rewrites every app.clerk_user_id policy to use it — matching the
-- pattern already used by users/api_keys/webhook_configs/approval_requests/
-- audit_log/custom_rules (those were already correct and are NOT touched here).
--
-- The app.invitation_token mechanism (team_invitations accept-by-token) is a
-- separate GUC and is intentionally left as-is.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE. Re-runnable.
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

-- ── teams ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "team members read team" ON public.teams;
CREATE POLICY "team members read team"
  ON public.teams FOR SELECT
  USING (id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = (auth.jwt() ->> 'sub')
  ));

DROP POLICY IF EXISTS "founder creates team" ON public.teams;
CREATE POLICY "founder creates team"
  ON public.teams FOR INSERT
  WITH CHECK (created_by = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "team managers update team" ON public.teams;
CREATE POLICY "team managers update team"
  ON public.teams FOR UPDATE
  USING (id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = (auth.jwt() ->> 'sub')
      AND role IN ('owner', 'manager')
  ));

-- ── team_members ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "team members read members" ON public.team_members;
CREATE POLICY "team members read members"
  ON public.team_members FOR SELECT
  USING (team_id IN (
    SELECT team_id FROM public.team_members m2
    WHERE m2.clerk_user_id = (auth.jwt() ->> 'sub')
  ));

DROP POLICY IF EXISTS "user inserts own membership" ON public.team_members;
CREATE POLICY "user inserts own membership"
  ON public.team_members FOR INSERT
  WITH CHECK (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "managers manage members" ON public.team_members;
CREATE POLICY "managers manage members"
  ON public.team_members FOR UPDATE
  USING (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = (auth.jwt() ->> 'sub')
      AND role IN ('owner', 'manager')
  ));

DROP POLICY IF EXISTS "managers delete members" ON public.team_members;
CREATE POLICY "managers delete members"
  ON public.team_members FOR DELETE
  USING (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = (auth.jwt() ->> 'sub')
      AND role IN ('owner', 'manager')
  ));

-- ── team_invitations ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers create invitations" ON public.team_invitations;
CREATE POLICY "managers create invitations"
  ON public.team_invitations FOR INSERT
  WITH CHECK (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = (auth.jwt() ->> 'sub')
      AND role IN ('owner', 'manager')
  ));

-- Mixed policy: keep the invitation-token branch, convert only the member branch.
DROP POLICY IF EXISTS "invitees read own invitation" ON public.team_invitations;
CREATE POLICY "invitees read own invitation"
  ON public.team_invitations FOR SELECT
  USING (
    token = current_setting('app.invitation_token', true)
    OR team_id IN (
      SELECT team_id FROM public.team_members
      WHERE clerk_user_id = (auth.jwt() ->> 'sub')
        AND role IN ('owner', 'manager')
    )
  );

-- NOTE: "invitees accept own invitation" uses only app.invitation_token (no
-- clerk_user_id), so it is intentionally left unchanged.

-- ── schema_connections ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users manage own connections" ON public.schema_connections;
CREATE POLICY "users manage own connections"
  ON public.schema_connections FOR ALL
  USING (user_id = (auth.jwt() ->> 'sub'));

-- ── saved_queries (query library) ────────────────────────────────────────────
DROP POLICY IF EXISTS "users manage own queries" ON public.saved_queries;
CREATE POLICY "users manage own queries"
  ON public.saved_queries FOR ALL
  USING (user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "team members read shared queries" ON public.saved_queries;
CREATE POLICY "team members read shared queries"
  ON public.saved_queries FOR SELECT
  USING (
    is_team_shared = true
    AND team_id IN (
      SELECT team_id FROM public.team_members
      WHERE clerk_user_id = (auth.jwt() ->> 'sub')
    )
  );

-- ── email_preferences ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users manage own preferences" ON public.email_preferences;
CREATE POLICY "users manage own preferences"
  ON public.email_preferences FOR ALL
  USING (user_id = (auth.jwt() ->> 'sub'));
