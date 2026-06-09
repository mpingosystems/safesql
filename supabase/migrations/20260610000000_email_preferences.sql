-- Sprint 10 Part 2 — email digest preferences. Per-user cadence for the weekly/
-- daily SQL health digest. Keyed by clerk_user_id (TEXT), consistent with the
-- other Sprint 8/9 tables.
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS public.email_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                     -- clerk_user_id
  digest_frequency TEXT DEFAULT 'weekly',    -- 'daily' | 'weekly' | 'never'
  digest_day INTEGER DEFAULT 1,              -- 0=Sun, 1=Mon ... 6=Sat (weekly)
  digest_hour INTEGER DEFAULT 9,             -- 0-23 UTC
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE public.email_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own preferences"
  ON public.email_preferences FOR ALL
  USING (user_id = current_setting('app.clerk_user_id', true));
