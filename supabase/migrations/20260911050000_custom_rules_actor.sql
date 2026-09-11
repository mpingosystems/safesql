-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 6/6: custom_rules become a managed, audited
-- team policy
-- Requires 20260911000000 (audit_events) and 20260911020000 (custom_rules_team_read).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Finding: nothing has ever written to custom_rules — the /team/rules page
-- authored and tested rules in React state only, and no caller passed rules
-- into the engine. Item 4 makes rules real: created / updated / deactivated /
-- deleted through service-role routes that record rule_created /
-- rule_updated / rule_deleted on the chain, and applied by POST /api/validate
-- for Business+ teams.
--
-- This file: actor + audit columns, a CHECK on rule_type / severity, and the
-- write-path change — browser clients can READ their team's rules (policy
-- from 3/4) but no longer write them directly (the legacy creator-only
-- FOR ALL policy is dropped), so a rule cannot change without a chain event.

-- ── Columns ─────────────────────────────────────────────────────────────────
ALTER TABLE public.custom_rules
  ADD COLUMN IF NOT EXISTS created_by_clerk_user_id TEXT,           -- survives user deletion (created_by is a uuid FK SET NULL)
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by_clerk_user_id TEXT,
  ADD COLUMN IF NOT EXISTS last_event_seq           BIGINT;         -- chain seq of the most recent rule_* event

-- Backfill the clerk id for any pre-existing rows (there should be none).
UPDATE public.custom_rules r
   SET created_by_clerk_user_id = u.clerk_user_id
  FROM public.users u
 WHERE u.id = r.created_by AND r.created_by_clerk_user_id IS NULL;

-- ── Constraints (the engine's five rule types; the report's three severities) ─
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_rules_type_check') THEN
    ALTER TABLE public.custom_rules
      ADD CONSTRAINT custom_rules_type_check CHECK (rule_type IN (
        'required_filter', 'forbidden_table', 'required_join_condition',
        'forbidden_pattern', 'required_column_qualification'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_rules_severity_check') THEN
    ALTER TABLE public.custom_rules
      ADD CONSTRAINT custom_rules_severity_check CHECK (severity IN ('error', 'warning', 'suggestion'));
  END IF;
END $$;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION public.custom_rules_touch() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS custom_rules_touch ON public.custom_rules;
CREATE TRIGGER custom_rules_touch
  BEFORE UPDATE ON public.custom_rules
  FOR EACH ROW EXECUTE FUNCTION public.custom_rules_touch();

-- ── Write path: API only ────────────────────────────────────────────────────
-- Reads: custom_rules_team_read (3/4) — every seated member.
-- Writes: nobody via PostgREST; the routes (service role) append the chain event.
DROP POLICY IF EXISTS "custom_rules_owner" ON public.custom_rules;
REVOKE INSERT, UPDATE, DELETE ON public.custom_rules FROM anon, authenticated;
GRANT  SELECT ON public.custom_rules TO authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'custom_rules';
--     → custom_rules_team_read (SELECT) only
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'custom_rules' AND column_name IN
--      ('created_by_clerk_user_id','updated_at','updated_by_clerk_user_id','last_event_seq');   -- 4 rows
--   SELECT conname FROM pg_constraint WHERE conname IN ('custom_rules_type_check','custom_rules_severity_check');
