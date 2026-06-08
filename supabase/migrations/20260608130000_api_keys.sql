-- Sprint 7 Part 3 — REST API keys + per-month usage counters.
-- Only the SHA-256 hash of a key is stored; the raw key is shown to the user
-- once at generation time. Apply via the Supabase SQL editor (this project is
-- not linked to the supabase CLI). Verify:
--   select count(*) from public.api_keys;
--   select count(*) from public.api_usage;

create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  key_hash    text unique not null,        -- SHA-256 of the raw key
  key_prefix  text not null,               -- first 12 chars for display
  plan        text not null,               -- pro | team | business
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);

create table if not exists public.api_usage (
  user_id     uuid not null references public.users(id) on delete cascade,
  month       text not null,               -- YYYY-MM
  call_count  integer not null default 0,
  primary key (user_id, month)
);

alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;

-- A user can see/manage their OWN keys (Clerk sub → users.clerk_user_id).
drop policy if exists "api_keys_owner_select" on public.api_keys;
create policy "api_keys_owner_select" on public.api_keys for select
  using (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));

drop policy if exists "api_keys_owner_insert" on public.api_keys;
create policy "api_keys_owner_insert" on public.api_keys for insert
  with check (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));

drop policy if exists "api_keys_owner_update" on public.api_keys;
create policy "api_keys_owner_update" on public.api_keys for update
  using (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));

-- api_usage is written only by the service-role API Function (bypasses RLS);
-- a user may read their own counters.
drop policy if exists "api_usage_owner_select" on public.api_usage;
create policy "api_usage_owner_select" on public.api_usage for select
  using (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));
