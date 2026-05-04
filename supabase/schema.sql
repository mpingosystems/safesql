-- SafeSQL canonical Postgres schema
-- Source of truth: paste this into Supabase SQL editor on first setup.
-- Extends TRD §3.7 with stripe_customer_id + stripe_subscription_id columns
-- needed by the /api/stripe/webhook Function (functions/api/stripe/webhook.ts).

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id            TEXT UNIQUE NOT NULL,
  email                    TEXT NOT NULL,
  plan                     TEXT NOT NULL DEFAULT 'free'
                              CHECK (plan IN ('free','pro','team','business')),
  stripe_customer_id       TEXT UNIQUE,
  stripe_subscription_id   TEXT UNIQUE,
  validations_this_month   INTEGER NOT NULL DEFAULT 0,
  sandbox_runs_this_month  INTEGER NOT NULL DEFAULT 0,
  usage_period_start       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schemas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     UUID,
  name        TEXT NOT NULL,
  ddl         TEXT NOT NULL,
  dialect     TEXT NOT NULL DEFAULT 'postgresql',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schemas_user_idx ON schemas(user_id);

CREATE TABLE IF NOT EXISTS validations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sql_hash      TEXT NOT NULL,
  schema_id     UUID REFERENCES schemas(id) ON DELETE SET NULL,
  report        JSONB NOT NULL,
  risk_score    INTEGER NOT NULL,
  error_count   INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  ai_enriched   BOOLEAN NOT NULL DEFAULT false,
  dialect       TEXT NOT NULL DEFAULT 'postgresql',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS validations_user_time_idx ON validations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sandboxes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schema_id       UUID REFERENCES schemas(id) ON DELETE SET NULL,
  neon_branch_id  TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Helper: monthly usage rollover ──────────────────────────────────────────
-- Resets a user's usage counters when usage_period_start is older than the
-- current month. SECURITY DEFINER so triggers can call it across RLS.

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

-- ── Triggers: atomically increment usage counters on insert ─────────────────
-- These bind the persistence write to the counter so a client can't bypass
-- the limit by skipping the increment. The functions run as SECURITY DEFINER
-- so they can update the users row (which the user owns under RLS anyway,
-- but DEFINER avoids any context drift).

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

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Strategy: Supabase project is configured to accept Clerk-issued JWTs by
-- adding Clerk's JWKS URL to Supabase Auth → Third Party Auth Providers.
-- Once configured, auth.jwt() returns the Clerk JWT and `auth.jwt() ->> 'sub'`
-- equals the Clerk user ID. The service-role key bypasses RLS for the
-- webhook Function.

ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE schemas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandboxes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users own self" ON users;
CREATE POLICY "users own self" ON users
  FOR ALL
  USING (clerk_user_id = (auth.jwt() ->> 'sub'))
  WITH CHECK (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "users own schemas" ON schemas;
CREATE POLICY "users own schemas" ON schemas
  FOR ALL
  USING (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  )
  WITH CHECK (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  );

DROP POLICY IF EXISTS "users own validations" ON validations;
CREATE POLICY "users own validations" ON validations
  FOR ALL
  USING (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  )
  WITH CHECK (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  );

DROP POLICY IF EXISTS "users own sandboxes" ON sandboxes;
CREATE POLICY "users own sandboxes" ON sandboxes
  FOR ALL
  USING (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  )
  WITH CHECK (
    user_id = (SELECT id FROM users WHERE clerk_user_id = (auth.jwt() ->> 'sub'))
  );
