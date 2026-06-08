-- Sprint 9 Part 2 — Schema Connector. Stores read-only database connections so
-- SafeSQL can auto-import a schema instead of requiring a DDL paste. The raw
-- connection string is NEVER stored: `encrypted_config` is AES-256-GCM ciphertext
-- produced and consumed only inside the Cloudflare Worker (key: SCHEMA_ENCRYPTION_KEY).
--
-- MANUAL APPLY: paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS public.schema_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,             -- clerk_user_id
  team_id UUID REFERENCES public.teams(id),
  name TEXT NOT NULL,                -- display name e.g. "Production DB"
  dialect TEXT NOT NULL,             -- 'postgresql' | 'mysql' | 'bigquery' | 'snowflake'
  connection_type TEXT NOT NULL,     -- 'connection_string' | 'bigquery_project' | 'snowflake_account'
  encrypted_config TEXT NOT NULL,    -- AES-256-GCM(base64(iv ‖ ciphertext))
  last_synced_at TIMESTAMPTZ,
  schema_cache JSONB,                -- cached SchemaDefinition after sync
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS schema_connections_user_idx ON public.schema_connections(user_id);

ALTER TABLE public.schema_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own connections"
  ON public.schema_connections FOR ALL
  USING (user_id = current_setting('app.clerk_user_id', true));
