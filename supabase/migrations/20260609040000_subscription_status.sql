-- Sprint 10 (Stripe live mode) — track subscription lifecycle state on users.
-- The webhook sets this from Stripe events: 'active' | 'past_due' | 'canceled'.
-- The webhook writes it best-effort, so the app keeps working until this is applied.
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active';
