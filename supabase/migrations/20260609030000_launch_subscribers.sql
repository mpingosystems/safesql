-- Sprint 9 Part 4 — launch notification list. Captures emails from the /launch
-- pre-launch page so we can notify subscribers on Product Hunt launch day.
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS public.launch_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  source TEXT DEFAULT 'launch_page',  -- 'launch_page' | 'blog' | 'hn'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.launch_subscribers ENABLE ROW LEVEL SECURITY;

-- Anyone (anon) may subscribe; nobody can read the list back from the client.
CREATE POLICY "anyone can subscribe"
  ON public.launch_subscribers FOR INSERT
  WITH CHECK (true);
