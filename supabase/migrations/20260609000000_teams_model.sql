-- Sprint 9 Part 1 — Teams / team_members / team_invitations model.
-- Resolves the Sprint 8 architectural gap: every Team-tier feature (analytics,
-- approvals, audit log, custom rules) becomes genuinely multi-user once these
-- tables exist. Auth is Clerk: members are keyed by clerk_user_id (TEXT), and
-- RLS reads the current user from the `app.clerk_user_id` GUC that the API
-- layer sets per request (matches the existing Sprint 8 migrations).
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run. Verify with:
--   SELECT count(*) FROM public.teams;
--   SELECT count(*) FROM public.team_members;

-- Teams ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,            -- url-safe team identifier
  plan TEXT NOT NULL DEFAULT 'team',    -- 'team' | 'business' | 'enterprise'
  created_by TEXT NOT NULL,             -- clerk_user_id of founder
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Team members ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'manager' | 'member'
  email TEXT NOT NULL,                  -- denormalized for display
  display_name TEXT,
  invited_by TEXT,                      -- clerk_user_id of inviter
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS team_members_user_idx ON public.team_members(clerk_user_id);
CREATE INDEX IF NOT EXISTS team_members_team_idx ON public.team_members(team_id);

-- Team invitations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT UNIQUE NOT NULL,           -- secure random token (nanoid)
  invited_by TEXT NOT NULL,             -- clerk_user_id
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_invitations_token_idx ON public.team_invitations(token);

-- RLS ------------------------------------------------------------------------
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;

-- Team members can see their own team.
CREATE POLICY "team members read team"
  ON public.teams FOR SELECT
  USING (id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
  ));

-- Founder can insert a team (created_by must be the acting user).
CREATE POLICY "founder creates team"
  ON public.teams FOR INSERT
  WITH CHECK (created_by = current_setting('app.clerk_user_id', true));

-- Only owner/manager can update the team.
CREATE POLICY "team managers update team"
  ON public.teams FOR UPDATE
  USING (id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
      AND role IN ('owner', 'manager')
  ));

-- Members can see their team's member list.
CREATE POLICY "team members read members"
  ON public.team_members FOR SELECT
  USING (team_id IN (
    SELECT team_id FROM public.team_members m2
    WHERE m2.clerk_user_id = current_setting('app.clerk_user_id', true)
  ));

-- A user can insert their own membership row (founder bootstrap + invite accept).
CREATE POLICY "user inserts own membership"
  ON public.team_members FOR INSERT
  WITH CHECK (clerk_user_id = current_setting('app.clerk_user_id', true));

-- Owner/manager can update or remove members.
CREATE POLICY "managers manage members"
  ON public.team_members FOR UPDATE
  USING (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
      AND role IN ('owner', 'manager')
  ));

CREATE POLICY "managers delete members"
  ON public.team_members FOR DELETE
  USING (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
      AND role IN ('owner', 'manager')
  ));

-- Invitations: managers create; invitees read via their token, managers read all.
CREATE POLICY "managers create invitations"
  ON public.team_invitations FOR INSERT
  WITH CHECK (team_id IN (
    SELECT team_id FROM public.team_members
    WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
      AND role IN ('owner', 'manager')
  ));

CREATE POLICY "invitees read own invitation"
  ON public.team_invitations FOR SELECT
  USING (
    token = current_setting('app.invitation_token', true)
    OR team_id IN (
      SELECT team_id FROM public.team_members
      WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
        AND role IN ('owner', 'manager')
    )
  );

CREATE POLICY "invitees accept own invitation"
  ON public.team_invitations FOR UPDATE
  USING (token = current_setting('app.invitation_token', true));

-- Backfill note: approval_requests, audit_log, custom_rules, webhook_configs
-- already carry a team_id TEXT column (Sprint 8). Sprint 9 stores the teams.id
-- UUID as text into those columns; no destructive ALTER is required.
