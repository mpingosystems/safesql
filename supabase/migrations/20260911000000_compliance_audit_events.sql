-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 1/4: tamper-evident audit event chain
-- Apply in the Supabase SQL editor (project qsrfsjjvsrrdvuvqitmc), in order:
--   20260911000000_compliance_audit_events.sql        ← this file
--   20260911010000_compliance_signing_and_bundles.sql
--   20260911020000_compliance_roles_and_approvals.sql
--   20260911030000_compliance_team_plan_sync.sql
-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE / DROP IF EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Design
--   • One chain per team. seq is 1-based and gapless per team; prev_hash of
--     seq 1 is 64 zeros (genesis).
--   • hash = sha256 of a fixed, newline-joined record:
--       prev_hash \n seq \n team_id \n event_type \n actor \n coalesce(subject,'')
--       \n created_at_iso \n payload_canonical
--     Every field is STORED, so an auditor can recompute the chain from an
--     export with any sha256 tool — nothing has to be re-serialised.
--   • payload_canonical is Postgres's own jsonb::text of payload, computed in
--     the trigger (keys ordered, whitespace normalised). A CHECK guarantees
--     it always represents `payload`, so the queryable JSON and the hashed
--     text cannot drift apart.
--   • Immutability: BEFORE UPDATE / DELETE / TRUNCATE triggers raise for
--     every role, service role included. Only a superuser dropping the
--     trigger could alter history — and that is visible in pg_trigger.
--   • No FK to users: deleting an account must not touch the chain
--     (ON DELETE SET NULL would be an UPDATE and would be blocked). The
--     actor is the Clerk user id as text, or a system principal such as
--     'system:stripe' / 'ci:github'.
--   • FK to teams is ON DELETE RESTRICT — evidence outlives intent to delete.
--   • Writes: service role only (no INSERT policy for authenticated). The
--     browser can read its own team's chain; it cannot append to it.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audit_events (
  team_id            UUID        NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  seq                BIGINT      NOT NULL,
  event_type         TEXT        NOT NULL,
  actor              TEXT        NOT NULL,             -- clerk_user_id | 'system:stripe' | 'ci:github' | 'api:<key_prefix>'
  actor_role         TEXT,                             -- owner | manager | member | auditor | NULL for system
  subject            TEXT,                             -- validation id, approval id, member clerk id, rule id …
  payload            JSONB       NOT NULL,
  payload_canonical  TEXT        NOT NULL,             -- set by trigger: payload::text
  prev_hash          TEXT        NOT NULL,             -- set by trigger
  hash               TEXT        NOT NULL,             -- set by trigger
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso     TEXT        NOT NULL,             -- set by trigger: UTC, microseconds, 'Z' — the exact text hashed
  PRIMARY KEY (team_id, seq),
  CONSTRAINT audit_events_hash_hex      CHECK (hash      ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_prev_hex      CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_seq_positive  CHECK (seq >= 1),
  CONSTRAINT audit_events_canonical_ok  CHECK (payload_canonical::jsonb = payload),
  CONSTRAINT audit_events_type_known    CHECK (event_type IN (
    'validation_run',
    'approval_requested', 'approval_approved', 'approval_rejected',
    'policy_created', 'policy_updated', 'policy_deleted',
    'rule_created', 'rule_updated', 'rule_deleted',
    'member_added', 'member_removed', 'member_role_changed',
    'plan_changed',
    'evidence_bundle_generated',
    'signing_key_rotated'
  ))
);

CREATE INDEX IF NOT EXISTS audit_events_team_created_idx ON public.audit_events (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_team_type_idx    ON public.audit_events (team_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_subject_idx      ON public.audit_events (team_id, subject);

-- ── Hash helpers ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.audit_event_hash(
  p_prev_hash TEXT, p_seq BIGINT, p_team_id UUID, p_event_type TEXT,
  p_actor TEXT, p_subject TEXT, p_created_at_iso TEXT, p_payload_canonical TEXT
) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(extensions.digest(convert_to(
           p_prev_hash            || E'\n' ||
           p_seq::text            || E'\n' ||
           p_team_id::text        || E'\n' ||
           p_event_type           || E'\n' ||
           p_actor                || E'\n' ||
           p_subject              || E'\n' ||   -- STRICT: callers pass coalesce(subject,'')
           p_created_at_iso       || E'\n' ||
           p_payload_canonical, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.audit_iso(ts TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

-- ── BEFORE INSERT: assign seq, link to previous, compute hash ───────────────

CREATE OR REPLACE FUNCTION public.audit_events_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  last_seq  BIGINT;
  last_hash TEXT;
BEGIN
  -- Serialise appends per team so two concurrent inserts cannot both read the
  -- same head. Transaction-scoped; released at commit.
  PERFORM pg_advisory_xact_lock(hashtext('audit_events:' || NEW.team_id::text));

  SELECT seq, hash INTO last_seq, last_hash
    FROM public.audit_events
   WHERE team_id = NEW.team_id
   ORDER BY seq DESC
   LIMIT 1;

  NEW.seq               := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash         := COALESCE(last_hash, repeat('0', 64));
  NEW.created_at        := COALESCE(NEW.created_at, now());
  NEW.created_at_iso    := public.audit_iso(NEW.created_at);
  NEW.payload_canonical := NEW.payload::text;
  NEW.hash := public.audit_event_hash(
    NEW.prev_hash, NEW.seq, NEW.team_id, NEW.event_type,
    NEW.actor, COALESCE(NEW.subject, ''), NEW.created_at_iso, NEW.payload_canonical);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_before_insert ON public.audit_events;
CREATE TRIGGER audit_events_before_insert
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_before_insert();

-- ── Immutability: no role may update, delete or truncate ────────────────────

CREATE OR REPLACE FUNCTION public.audit_events_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked on team % seq %)',
    TG_OP, COALESCE(OLD.team_id::text, '?'), COALESCE(OLD.seq::text, '?')
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_events_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (TRUNCATE blocked)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON public.audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_immutable();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON public.audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_no_truncate();

-- ── Append helper (used by DB triggers in later migrations and by the API) ──
-- Returns the new seq. SECURITY DEFINER so a trigger on `users` (fired by the
-- Stripe webhook's service-role update) can append without the caller having
-- insert rights on audit_events. Not granted to authenticated/anon.

CREATE OR REPLACE FUNCTION public.audit_append(
  p_team_id UUID, p_event_type TEXT, p_actor TEXT, p_actor_role TEXT,
  p_subject TEXT, p_payload JSONB
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE new_seq BIGINT;
BEGIN
  INSERT INTO public.audit_events (team_id, event_type, actor, actor_role, subject, payload, payload_canonical, prev_hash, hash, created_at_iso)
  VALUES (p_team_id, p_event_type, p_actor, p_actor_role, p_subject, COALESCE(p_payload, '{}'::jsonb), '', repeat('0',64), repeat('0',64), '')
  RETURNING seq INTO new_seq;   -- trigger overwrites the placeholder chain fields
  RETURN new_seq;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_append(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- ── Verification (auditor-callable via RPC) ─────────────────────────────────
-- SECURITY INVOKER: RLS decides which rows the caller can see, so a member can
-- only ever verify their own team's chain. Returns one row.

CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  p_team_id UUID, p_from_seq BIGINT DEFAULT 1, p_to_seq BIGINT DEFAULT NULL
) RETURNS TABLE (
  ok BOOLEAN, checked BIGINT, first_seq BIGINT, last_seq BIGINT, head_hash TEXT,
  first_bad_seq BIGINT, expected_hash TEXT, actual_hash TEXT, reason TEXT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r          RECORD;
  prev       TEXT := NULL;
  prev_seq   BIGINT := NULL;
  n          BIGINT := 0;
  calc       TEXT;
BEGIN
  ok := TRUE; checked := 0; first_seq := NULL; last_seq := NULL; head_hash := NULL;
  first_bad_seq := NULL; expected_hash := NULL; actual_hash := NULL; reason := NULL;

  FOR r IN
    SELECT * FROM public.audit_events
     WHERE team_id = p_team_id
       AND seq >= p_from_seq
       AND (p_to_seq IS NULL OR seq <= p_to_seq)
     ORDER BY seq
  LOOP
    IF first_seq IS NULL THEN
      first_seq := r.seq;
      -- Starting mid-chain: trust the stored prev_hash as the anchor.
      prev := r.prev_hash;
      IF r.seq = 1 AND r.prev_hash <> repeat('0', 64) THEN
        ok := FALSE; first_bad_seq := r.seq; reason := 'genesis prev_hash is not zero'; RETURN NEXT; RETURN;
      END IF;
    ELSIF r.seq <> prev_seq + 1 THEN
      ok := FALSE; first_bad_seq := r.seq; reason := 'gap in seq'; RETURN NEXT; RETURN;
    ELSIF r.prev_hash <> prev THEN
      ok := FALSE; first_bad_seq := r.seq; expected_hash := prev; actual_hash := r.prev_hash;
      reason := 'prev_hash does not match previous row hash'; RETURN NEXT; RETURN;
    END IF;

    IF r.payload_canonical::jsonb <> r.payload THEN
      ok := FALSE; first_bad_seq := r.seq; reason := 'payload_canonical does not represent payload'; RETURN NEXT; RETURN;
    END IF;

    calc := public.audit_event_hash(r.prev_hash, r.seq, r.team_id, r.event_type, r.actor,
                                    COALESCE(r.subject, ''), r.created_at_iso, r.payload_canonical);
    IF calc <> r.hash THEN
      ok := FALSE; first_bad_seq := r.seq; expected_hash := calc; actual_hash := r.hash;
      reason := 'row hash does not match its contents'; RETURN NEXT; RETURN;
    END IF;

    prev := r.hash; prev_seq := r.seq; n := n + 1; last_seq := r.seq; head_hash := r.hash;
  END LOOP;

  checked := n;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_audit_chain(UUID, BIGINT, BIGINT) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read: any seated member of the team (owner / manager / member / auditor).
-- Write: nobody through PostgREST — the API (service role) appends.

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_events_team_read" ON public.audit_events;
CREATE POLICY "audit_events_team_read" ON public.audit_events
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_events FROM anon, authenticated;
GRANT  SELECT ON public.audit_events TO authenticated;

-- ── Bridge from the Sprint-8 (build track) audit_log ────────────────────────
-- Managers and auditors can now read the whole team's legacy audit_log rows
-- (the policy that was left commented out in 20260608160000_audit_log.sql).
DROP POLICY IF EXISTS "audit_log_team_read" ON public.audit_log;
CREATE POLICY "audit_log_team_read" ON public.audit_log
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')
                        AND role IN ('owner', 'manager', 'auditor')));

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.audit_events'::regclass;
--     → audit_events_before_insert, audit_events_no_update, audit_events_no_truncate (tgenabled = 'O')
--   SELECT proname FROM pg_proc WHERE proname IN ('audit_append','audit_event_hash','verify_audit_chain','audit_iso');
--   -- append two events as service role, then:
--   SELECT * FROM public.verify_audit_chain('<team_id>');   -- ok = true, checked = 2
--   UPDATE public.audit_events SET actor = 'x' WHERE seq = 1;  -- must FAIL: append-only
