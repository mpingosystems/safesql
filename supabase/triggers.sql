-- SafeSQL — usage-counter triggers (re-runnable patch)
-- Paste this into Supabase SQL editor if `users.validations_this_month`
-- doesn't increment when a row is inserted into `validations`.
-- Idempotent — safe to re-run any time.
--
-- Diagnosis (May 4, 2026): the original schema.sql deploy created the four
-- tables but skipped the function/trigger blocks below, so writes to
-- `validations` and `sandboxes` weren't bumping the per-user monthly counter
-- the free-tier gate (B4) reads.

-- ── Helper: monthly usage rollover ──────────────────────────────────────────
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

-- ── Trigger: bump validation count on insert ────────────────────────────────
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

-- ── Trigger: bump sandbox count on insert ───────────────────────────────────
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
