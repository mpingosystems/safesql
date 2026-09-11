-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 5/5: let a resolved approval request record
-- its chain event seq, exactly once
-- Requires 20260911020000_compliance_roles_and_approvals.sql.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Why: the safe resolve order is
--   1. UPDATE approval_requests  (status + approver fields)   — may lose a race → 0 rows, stop
--   2. append approval_approved / approval_rejected to the chain
--   3. UPDATE approval_requests SET resolution_event_seq = <seq>
-- Step 3 touches a row that is already resolved, which the guard from 3/4
-- froze completely. This replaces the guard so that ONE column —
-- resolution_event_seq — may go from NULL to a value, once, on a resolved
-- row. Every other rule is unchanged: pending → approved|rejected exactly
-- once, approver ≠ requester, approver role ∈ (owner, manager), identity /
-- SQL / report / score never change, no DELETE.

CREATE OR REPLACE FUNCTION public.approval_requests_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_requests are retained; DELETE is not permitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    -- Editing a pending request: allow note/metadata changes, never identity.
    IF NEW.requester_id IS DISTINCT FROM OLD.requester_id
       OR NEW.requester_clerk_user_id IS DISTINCT FROM OLD.requester_clerk_user_id
       OR NEW.team_id IS DISTINCT FROM OLD.team_id
       OR NEW.sql IS DISTINCT FROM OLD.sql
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.risk_score IS DISTINCT FROM OLD.risk_score THEN
      RAISE EXCEPTION 'a pending approval request cannot change its requester, team, SQL, report or score'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.approver_clerk_user_id IS NULL OR NEW.approver_role IS NULL THEN
      RAISE EXCEPTION 'resolving an approval request requires approver_clerk_user_id and approver_role'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.approver_clerk_user_id = OLD.requester_clerk_user_id
       OR (NEW.approver_id IS NOT NULL AND NEW.approver_id = OLD.requester_id) THEN
      RAISE EXCEPTION 'separation of duties: the requester cannot resolve their own request'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.approver_role NOT IN ('owner', 'manager') THEN
      RAISE EXCEPTION 'only an owner or manager may resolve an approval request (got %)', NEW.approver_role
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    -- Immutable fields stay as they were.
    NEW.requester_id := OLD.requester_id;
    NEW.requester_clerk_user_id := OLD.requester_clerk_user_id;
    NEW.team_id := OLD.team_id;
    NEW.sql := OLD.sql;
    NEW.validation_report := OLD.validation_report;
    NEW.risk_score := OLD.risk_score;
    NEW.created_at := OLD.created_at;
    RETURN NEW;
  END IF;

  -- Already resolved. Two changes may pass, nothing else:
  --   (a) FK SET NULL on user deletion (requester_id / approver_id → NULL)
  --   (b) resolution_event_seq NULL → value, once  (Sprint 9 5/5)
  IF OLD.status IN ('approved', 'rejected') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approver_note IS DISTINCT FROM OLD.approver_note
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.approver_clerk_user_id IS DISTINCT FROM OLD.approver_clerk_user_id
       OR NEW.approver_role IS DISTINCT FROM OLD.approver_role
       OR NEW.sql IS DISTINCT FROM OLD.sql
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.risk_score IS DISTINCT FROM OLD.risk_score
       OR NEW.trigger_reasons IS DISTINCT FROM OLD.trigger_reasons
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.request_event_seq IS DISTINCT FROM OLD.request_event_seq
       OR (NEW.requester_id IS NOT NULL AND NEW.requester_id IS DISTINCT FROM OLD.requester_id)
       OR (NEW.approver_id  IS NOT NULL AND NEW.approver_id  IS DISTINCT FROM OLD.approver_id) THEN
      RAISE EXCEPTION 'a resolved approval request is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.resolution_event_seq IS DISTINCT FROM OLD.resolution_event_seq THEN
      IF OLD.resolution_event_seq IS NOT NULL THEN
        RAISE EXCEPTION 'resolution_event_seq is already recorded (%) and cannot change', OLD.resolution_event_seq
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.resolution_event_seq IS NULL OR NEW.resolution_event_seq < 1 THEN
        RAISE EXCEPTION 'resolution_event_seq must be a positive chain seq'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid approval_requests transition % -> %', OLD.status, NEW.status
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- The trigger already points at this function (CREATE OR REPLACE keeps the
-- binding); re-declared here so the file is self-sufficient if run alone.
DROP TRIGGER IF EXISTS approval_requests_guard ON public.approval_requests;
CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.approval_requests_guard();

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   -- on a resolved request with resolution_event_seq IS NULL (service role):
--   UPDATE public.approval_requests SET resolution_event_seq = 42 WHERE id = '…';   -- OK
--   UPDATE public.approval_requests SET resolution_event_seq = 43 WHERE id = '…';   -- FAIL: already recorded
--   UPDATE public.approval_requests SET approver_note = 'x'   WHERE id = '…';       -- FAIL: immutable
