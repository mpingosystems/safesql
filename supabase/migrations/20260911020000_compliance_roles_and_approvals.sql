-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 3/4: auditor role, approval policies,
-- approval_requests hardening (separation of duties), custom_rules team read
-- Requires 20260911000000 and 20260911010000.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3. Auditor role ─────────────────────────────────────────────────────────
-- Read-only: sees the audit trail, chain, bundles and approvals; can export;
-- cannot approve, invite, remove, or change rules/policies. Every existing
-- write policy is scoped to owner/manager, so auditor is excluded from them
-- by construction. Decision: an auditor occupies a seat (the seat-cap
-- trigger counts all rows; not changed).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_role_check') THEN
    ALTER TABLE public.team_members
      ADD CONSTRAINT team_members_role_check
      CHECK (role IN ('owner', 'manager', 'member', 'auditor'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_invitations_role_check') THEN
    ALTER TABLE public.team_invitations
      ADD CONSTRAINT team_invitations_role_check
      CHECK (role IN ('manager', 'member', 'auditor'));   -- owner is never invited
  END IF;
END $$;

-- ── 5. Approval policies — deterministic trigger conditions ────────────────
-- A validation REQUIRES approval when, for any active policy of the team:
--     risk_score < min_score            (when min_score is set)
--  OR any fired detector id ∈ detector_ids
--  OR (require_for_destructive AND any of DESTRUCTIVE_DDL / DESTRUCTIVE_TRUNCATE /
--      MISSING_WHERE_DESTRUCTIVE fired)
-- Evaluation is a pure function of (report, policies) in the engine — no AI.
-- approver_roles says who may resolve; the requester never may (enforced
-- below regardless of role).

CREATE TABLE IF NOT EXISTS public.approval_policies (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                  UUID        NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name                     TEXT        NOT NULL,
  description              TEXT,
  active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  min_score                INTEGER     CHECK (min_score IS NULL OR (min_score BETWEEN 0 AND 100)),
  detector_ids             TEXT[]      NOT NULL DEFAULT '{}',
  require_for_destructive  BOOLEAN     NOT NULL DEFAULT TRUE,
  approver_roles           TEXT[]      NOT NULL DEFAULT ARRAY['owner', 'manager'],
  created_by               TEXT        NOT NULL,       -- clerk_user_id
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_has_condition CHECK (
    min_score IS NOT NULL OR cardinality(detector_ids) > 0 OR require_for_destructive
  ),
  CONSTRAINT approval_policies_roles CHECK (
    approver_roles <@ ARRAY['owner', 'manager']::text[] AND cardinality(approver_roles) > 0
  )
);

CREATE INDEX IF NOT EXISTS approval_policies_team_idx ON public.approval_policies (team_id, active);

ALTER TABLE public.approval_policies ENABLE ROW LEVEL SECURITY;

-- Members read their team's policies (the editor needs them to know when to
-- ask for approval). Writes go through the API (service role) so every
-- change lands on the chain as policy_created / policy_updated / policy_deleted.
DROP POLICY IF EXISTS "approval_policies_team_read" ON public.approval_policies;
CREATE POLICY "approval_policies_team_read" ON public.approval_policies
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')));
REVOKE INSERT, UPDATE, DELETE ON public.approval_policies FROM anon, authenticated;
GRANT  SELECT ON public.approval_policies TO authenticated;

-- Default policy for every existing team (and for new teams, via trigger):
-- the score policy's high-risk line plus the two dbt detectors and destructive SQL.
CREATE OR REPLACE FUNCTION public.teams_create_default_policy() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.approval_policies (team_id, name, description, min_score, detector_ids, require_for_destructive, created_by)
  VALUES (
    NEW.id,
    'Default — high-risk and governed sources',
    'Requires approval below the 70 score line, for raw-source reads past a trusted mart, for finance/pii-tagged relations with a failed last run, and for destructive SQL.',
    70,
    ARRAY['UNAPPROVED_SOURCE', 'FINANCE_TAG_UNVALIDATED'],
    TRUE,
    'system:default'
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teams_create_default_policy ON public.teams;
CREATE TRIGGER teams_create_default_policy
  AFTER INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.teams_create_default_policy();

INSERT INTO public.approval_policies (team_id, name, description, min_score, detector_ids, require_for_destructive, created_by)
SELECT t.id,
       'Default — high-risk and governed sources',
       'Requires approval below the 70 score line, for raw-source reads past a trusted mart, for finance/pii-tagged relations with a failed last run, and for destructive SQL.',
       70, ARRAY['UNAPPROVED_SOURCE', 'FINANCE_TAG_UNVALIDATED'], TRUE, 'system:default'
  FROM public.teams t
 WHERE NOT EXISTS (SELECT 1 FROM public.approval_policies p WHERE p.team_id = t.id);

-- ── 4. approval_requests — record who approved, enforce separation of duties ─

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS policy_id              UUID REFERENCES public.approval_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trigger_reasons        TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {'score<70','UNAPPROVED_SOURCE'}
  ADD COLUMN IF NOT EXISTS requester_clerk_user_id TEXT,                          -- survives user deletion
  ADD COLUMN IF NOT EXISTS approver_clerk_user_id TEXT,
  ADD COLUMN IF NOT EXISTS approver_role          TEXT,
  ADD COLUMN IF NOT EXISTS request_event_seq      BIGINT,                          -- chain seq of approval_requested
  ADD COLUMN IF NOT EXISTS resolution_event_seq   BIGINT;                          -- chain seq of approval_approved / _rejected

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_status_check') THEN
    ALTER TABLE public.approval_requests
      ADD CONSTRAINT approval_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS approval_requests_team_created_idx ON public.approval_requests (team_id, created_at DESC);

-- Backfill the clerk id of existing requesters (users.id → clerk_user_id).
UPDATE public.approval_requests r
   SET requester_clerk_user_id = u.clerk_user_id
  FROM public.users u
 WHERE u.id = r.requester_id AND r.requester_clerk_user_id IS NULL;

-- State machine + separation of duties, enforced for every role:
--   pending → approved | rejected, exactly once, by someone who is not the
--   requester, with approver identity and time recorded. A resolved request
--   is frozen except for FK SET NULL on user deletion (requester_id /
--   approver_id → NULL), which is the only later change permitted.
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

  -- Already resolved: only FK SET NULL (user deletion) may pass, and only that.
  IF OLD.status IN ('approved', 'rejected') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approver_note IS DISTINCT FROM OLD.approver_note
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.approver_clerk_user_id IS DISTINCT FROM OLD.approver_clerk_user_id
       OR NEW.approver_role IS DISTINCT FROM OLD.approver_role
       OR NEW.resolution_event_seq IS DISTINCT FROM OLD.resolution_event_seq
       OR NEW.sql IS DISTINCT FROM OLD.sql
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.risk_score IS DISTINCT FROM OLD.risk_score
       OR (NEW.requester_id IS NOT NULL AND NEW.requester_id IS DISTINCT FROM OLD.requester_id)
       OR (NEW.approver_id  IS NOT NULL AND NEW.approver_id  IS DISTINCT FROM OLD.approver_id) THEN
      RAISE EXCEPTION 'a resolved approval request is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid approval_requests transition % -> %', OLD.status, NEW.status
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS approval_requests_guard ON public.approval_requests;
CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.approval_requests_guard();

-- RLS: replace the requester-only FOR ALL policy (which let a requester
-- approve their own request and hid requests from everyone else).
--   SELECT — any seated member of the team
--   INSERT — the requester, for their own team
--   UPDATE/DELETE — nobody via PostgREST; resolution goes through the
--   service-role API, which also appends the chain event.
DROP POLICY IF EXISTS "approval_requests_access" ON public.approval_requests;

DROP POLICY IF EXISTS "approval_requests_team_read" ON public.approval_requests;
CREATE POLICY "approval_requests_team_read" ON public.approval_requests
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS "approval_requests_requester_insert" ON public.approval_requests;
CREATE POLICY "approval_requests_requester_insert" ON public.approval_requests
  FOR INSERT
  WITH CHECK (
    requester_id IN (SELECT id FROM public.users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
    AND team_id IN (SELECT team_id FROM public.team_members
                     WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  );

REVOKE UPDATE, DELETE ON public.approval_requests FROM anon, authenticated;
GRANT  SELECT, INSERT ON public.approval_requests TO authenticated;

-- ── custom_rules: the whole team can read its rules ────────────────────────
-- Today only the creator can see a rule, so nobody else's editor applies it.
-- Server-side enforcement (item 5) runs as service role and is unaffected;
-- this makes the browser consistent with it. Writes stay creator-only here
-- and move to the API for chain logging in the application part.
DROP POLICY IF EXISTS "custom_rules_team_read" ON public.custom_rules;
CREATE POLICY "custom_rules_team_read" ON public.custom_rules
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')));

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT conname FROM pg_constraint WHERE conname IN
--     ('team_members_role_check','team_invitations_role_check','approval_requests_status_check');
--   SELECT count(*) FROM public.approval_policies;             -- = number of teams
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'approval_requests';
--     → approval_requests_team_read (SELECT), approval_requests_requester_insert (INSERT) only
--   -- as service role, on a pending request where requester = approver:
--   UPDATE public.approval_requests SET status='approved', approver_clerk_user_id=requester_clerk_user_id, approver_role='owner' WHERE id='…';
--     → must FAIL: separation of duties
