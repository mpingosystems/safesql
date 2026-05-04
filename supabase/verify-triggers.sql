-- Run this in the Supabase SQL editor and paste the output back.
-- It (1) re-applies the trigger DDL idempotently, then (2) reports the
-- live state so we can confirm the triggers were actually installed.

-- ── (1) Re-apply trigger DDL (no-op if already correct) ─────────────────────
CREATE OR REPLACE FUNCTION roll_usage_period(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE users
  SET validations_this_month = 0,
      sandbox_runs_this_month = 0,
      usage_period_start = date_trunc('month', NOW())
  WHERE id = p_user_id
    AND usage_period_start < date_trunc('month', NOW());
END;
$$;

CREATE OR REPLACE FUNCTION bump_user_validation_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM roll_usage_period(NEW.user_id);
  UPDATE users
  SET validations_this_month = validations_this_month + 1
  WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_validations_on_insert ON validations;
CREATE TRIGGER bump_validations_on_insert
AFTER INSERT ON validations
FOR EACH ROW EXECUTE FUNCTION bump_user_validation_count();

CREATE OR REPLACE FUNCTION bump_user_sandbox_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM roll_usage_period(NEW.user_id);
  UPDATE users
  SET sandbox_runs_this_month = sandbox_runs_this_month + 1
  WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_sandboxes_on_insert ON sandboxes;
CREATE TRIGGER bump_sandboxes_on_insert
AFTER INSERT ON sandboxes
FOR EACH ROW EXECUTE FUNCTION bump_user_sandbox_count();

-- ── (2) Diagnostic — report actual live state ───────────────────────────────
SELECT 'functions' AS kind, proname AS name, pronamespace::regnamespace AS schema
FROM pg_proc
WHERE proname IN (
  'bump_user_validation_count',
  'bump_user_sandbox_count',
  'roll_usage_period'
)
UNION ALL
SELECT 'triggers' AS kind,
       tgname AS name,
       tgrelid::regclass::text AS schema
FROM pg_trigger
WHERE tgname IN ('bump_validations_on_insert','bump_sandboxes_on_insert')
ORDER BY kind, name;
