-- Sprint 11 Part 5 — track pre-launch email sends so each launch subscriber is
-- notified at most once (rate-limit for POST /api/launch/notify).
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run. Idempotent.

ALTER TABLE public.launch_subscribers
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
