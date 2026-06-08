-- Sprint 9 Part 3 — Query Library. Lets analysts save validated queries, tag
-- them, and share with their team — the "data gravity" retention moat. Keyed by
-- the same user identifier as the sibling tables; team sharing is gated on
-- team_members via RLS.
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS public.saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                 -- clerk_user_id / app user id
  team_id UUID REFERENCES public.teams(id),
  title TEXT NOT NULL,
  description TEXT,
  sql TEXT NOT NULL,
  ddl TEXT,                              -- schema DDL used with this query
  dialect TEXT DEFAULT 'postgresql',
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  last_risk_score INTEGER,               -- score from last validation
  last_validated_at TIMESTAMPTZ,
  is_team_shared BOOLEAN DEFAULT false,  -- visible to the whole team
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS saved_queries_user_idx ON public.saved_queries(user_id);
CREATE INDEX IF NOT EXISTS saved_queries_team_idx ON public.saved_queries(team_id);

ALTER TABLE public.saved_queries ENABLE ROW LEVEL SECURITY;

-- Personal queries: owner-only full access.
CREATE POLICY "users manage own queries"
  ON public.saved_queries FOR ALL
  USING (user_id = current_setting('app.clerk_user_id', true));

-- Team-shared queries: any team member can read.
CREATE POLICY "team members read shared queries"
  ON public.saved_queries FOR SELECT
  USING (
    is_team_shared = true
    AND team_id IN (
      SELECT team_id FROM public.team_members
      WHERE clerk_user_id = current_setting('app.clerk_user_id', true)
    )
  );
