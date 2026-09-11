-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 2/4: per-team HMAC signing keys + evidence bundles
-- Requires 20260911000000_compliance_audit_events.sql.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Why a separate table and not `teams.signing_key`:
--   Supabase grants table-level SELECT on public tables to `authenticated`.
--   Column-level REVOKE cannot subtract from a table-level GRANT, so a key
--   column on `teams` would be readable by any seated member through
--   PostgREST. `team_signing_keys` has RLS enabled and NO policies: invisible
--   to anon/authenticated, readable only by the service role (the API).
--
-- Key material: 32 random bytes (pgcrypto), stored hex. HMAC-SHA256 over the
-- bundle hash is computed in the API with this key. Rotation keeps the old
-- key so historical signatures stay verifiable (version recorded on each
-- bundle). Rotation is itself an audit event.

-- ── Signing keys ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.team_signing_keys (
  team_id     UUID        NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  version     INTEGER     NOT NULL DEFAULT 1,
  key_hex     TEXT        NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ,
  PRIMARY KEY (team_id, version),
  CONSTRAINT team_signing_keys_hex CHECK (key_hex ~ '^[0-9a-f]{64}$')
);

-- Exactly one active key per team.
CREATE UNIQUE INDEX IF NOT EXISTS team_signing_keys_one_active
  ON public.team_signing_keys (team_id) WHERE active;

ALTER TABLE public.team_signing_keys ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: service role only.
REVOKE ALL ON public.team_signing_keys FROM anon, authenticated;

-- Generate a key at team creation, with no application change required.
CREATE OR REPLACE FUNCTION public.teams_create_signing_key() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  INSERT INTO public.team_signing_keys (team_id) VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teams_create_signing_key ON public.teams;
CREATE TRIGGER teams_create_signing_key
  AFTER INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.teams_create_signing_key();

-- Backfill every existing team.
INSERT INTO public.team_signing_keys (team_id)
SELECT t.id FROM public.teams t
WHERE NOT EXISTS (SELECT 1 FROM public.team_signing_keys k WHERE k.team_id = t.id);

-- Rotation: retire the active key, mint the next version, record it on the chain.
-- Service-role only (called by the API on an owner's request).
CREATE OR REPLACE FUNCTION public.rotate_team_signing_key(p_team_id UUID, p_actor TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE next_version INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('team_signing_keys:' || p_team_id::text));
  UPDATE public.team_signing_keys
     SET active = FALSE, retired_at = now()
   WHERE team_id = p_team_id AND active;
  SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM public.team_signing_keys WHERE team_id = p_team_id;
  INSERT INTO public.team_signing_keys (team_id, version) VALUES (p_team_id, next_version);
  PERFORM public.audit_append(p_team_id, 'signing_key_rotated', p_actor, 'owner', NULL,
                              jsonb_build_object('version', next_version));
  RETURN next_version;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_team_signing_key(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ── Evidence bundles ────────────────────────────────────────────────────────
-- A bundle is a manifest over a contiguous segment of the team's chain for a
-- date range. The chain is immutable, so regenerating the same segment yields
-- byte-identical content and the same bundle_hash — the manifest, not a copy
-- of the rows, is what is stored. Validations and approvals are already
-- events in the chain, so the bundle needs no second data source.
--
-- bundle_hash  = sha256 over the canonical bundle document built by the API
--                (see functions/api/teams/evidence.ts — documented there and
--                in the bundle's own README so an auditor can recompute it).
-- signature    = HMAC-SHA256(key_hex[version], bundle_hash), hex.

CREATE TABLE IF NOT EXISTS public.evidence_bundles (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id             UUID        NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  period_from         TIMESTAMPTZ NOT NULL,
  period_to           TIMESTAMPTZ NOT NULL,
  chain_from_seq      BIGINT      NOT NULL,
  chain_to_seq        BIGINT      NOT NULL,
  chain_head_hash     TEXT        NOT NULL,             -- hash of chain_to_seq at generation time
  event_count         INTEGER     NOT NULL,
  validation_count    INTEGER     NOT NULL DEFAULT 0,
  approval_count      INTEGER     NOT NULL DEFAULT 0,
  bundle_hash         TEXT        NOT NULL,
  signature           TEXT        NOT NULL,
  signing_key_version INTEGER     NOT NULL,
  generated_by        TEXT        NOT NULL,             -- clerk_user_id (no FK: immutable row)
  generated_by_role   TEXT        NOT NULL,
  format_version      INTEGER     NOT NULL DEFAULT 1,   -- bundle document schema version
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_bundles_period   CHECK (period_to >= period_from),
  CONSTRAINT evidence_bundles_range    CHECK (chain_to_seq >= chain_from_seq AND chain_from_seq >= 1),
  CONSTRAINT evidence_bundles_hash_hex CHECK (bundle_hash ~ '^[0-9a-f]{64}$' AND signature ~ '^[0-9a-f]{64}$' AND chain_head_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_bundles_key_fk   FOREIGN KEY (team_id, signing_key_version)
    REFERENCES public.team_signing_keys (team_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS evidence_bundles_team_idx ON public.evidence_bundles (team_id, created_at DESC);

-- Immutable, like the chain it summarises (reuse the generic raise functions).
DROP TRIGGER IF EXISTS evidence_bundles_no_update ON public.evidence_bundles;
CREATE TRIGGER evidence_bundles_no_update
  BEFORE UPDATE OR DELETE ON public.evidence_bundles
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_immutable();

DROP TRIGGER IF EXISTS evidence_bundles_no_truncate ON public.evidence_bundles;
CREATE TRIGGER evidence_bundles_no_truncate
  BEFORE TRUNCATE ON public.evidence_bundles
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_no_truncate();

ALTER TABLE public.evidence_bundles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_bundles_team_read" ON public.evidence_bundles;
CREATE POLICY "evidence_bundles_team_read" ON public.evidence_bundles
  FOR SELECT
  USING (team_id IN (SELECT team_id FROM public.team_members
                      WHERE clerk_user_id = (auth.jwt() ->> 'sub')));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.evidence_bundles FROM anon, authenticated;
GRANT  SELECT ON public.evidence_bundles TO authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT count(*) FROM public.team_signing_keys;          -- = number of teams
--   SELECT team_id, version, active, length(key_hex) FROM public.team_signing_keys;  -- 64
--   -- as an authenticated (non-service) session:
--   SELECT * FROM public.team_signing_keys;                  -- 0 rows / permission denied
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.evidence_bundles'::regclass;
