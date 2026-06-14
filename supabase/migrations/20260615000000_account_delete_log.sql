-- Sprint 12 Part 3 — audit log of self-serve account deletions. Service-role only
-- (the delete Worker writes here); no client access.
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS public.account_deletions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL,
  email         TEXT,
  reason        TEXT,
  deleted_at    TIMESTAMPTZ DEFAULT NOW()
);

-- No RLS policies — only the service-role key (Workers) may read/write this table.
ALTER TABLE public.account_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletions FROM anon, authenticated;
