-- Sprint 5 / v0.3.0 — DB-backed short-URL validation permalinks.
-- A row is created (anon or authed) when a user clicks "Share"; the 12-char
-- nanoid `id` is the capability and the only thing in the public URL
-- (safesql.realitydb.dev/v/{id}). Rows auto-expire after 30 days.
--
-- Idempotent: safe to re-run. Apply via the Supabase SQL editor (this project
-- applies schema there, not via `supabase db push`). After running, verify with:
--   select count(*) from public.shared_validations;        -- table exists
--   select polname from pg_policies where tablename = 'shared_validations';

create table if not exists public.shared_validations (
  id          text primary key,                 -- 12-char nanoid
  sql         text        not null,
  issues      jsonb       not null,             -- ValidationIssue[]
  score       integer     not null,             -- 0-100 riskScore
  dialect     text,                             -- postgresql / mysql / bigquery / snowflake
  ddl         text,                             -- DDL used, nullable
  source      text,                             -- cursor / copilot / chatgpt / manual / unknown
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '30 days')
);

-- Speeds up the not-expired filter on read.
create index if not exists shared_validations_expires_at_idx
  on public.shared_validations (expires_at);

alter table public.shared_validations enable row level security;

-- Public read: anyone holding the link can view it (the unguessable id IS the
-- access grant — intentionally public, no PII beyond the SQL the author shared).
drop policy if exists "shared_validations_public_read" on public.shared_validations;
create policy "shared_validations_public_read"
  on public.shared_validations
  for select
  using (true);

-- Anyone (anon or authenticated) can create a permalink — it's the Team-tier
-- organic acquisition channel, so it must work without login.
drop policy if exists "shared_validations_anon_insert" on public.shared_validations;
create policy "shared_validations_anon_insert"
  on public.shared_validations
  for insert
  with check (true);

-- No UPDATE or DELETE policies → both denied by RLS. Expiry handles cleanup.
