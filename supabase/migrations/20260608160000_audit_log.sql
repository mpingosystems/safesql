-- Sprint 8 Part 4 — SOC 2-aligned append-only audit log.
-- Adapted to the project's Clerk/users model. The team-manager read policy
-- references `team_members` (not yet present) — commented; a user-owns-own read
-- policy is used meanwhile. Flagged for Sprint 8 reconciliation.

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid,
  user_id     uuid references public.users(id) on delete set null,
  event_type  text not null,
  event_data  jsonb not null,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz default now()
);
create index if not exists audit_log_team_idx on public.audit_log (team_id, created_at desc);
create index if not exists audit_log_user_idx on public.audit_log (user_id, created_at desc);

alter table public.audit_log enable row level security;

-- Append-only: only SELECT + INSERT policies (no UPDATE/DELETE → denied by RLS).
drop policy if exists "audit_log_read_own" on public.audit_log;
create policy "audit_log_read_own" on public.audit_log for select
  using (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));
-- (Business: managers read the whole team — enable once team_members exists)
-- create policy "audit_log_team_managers" on public.audit_log for select
--   using (team_id in (select team_id from public.team_members
--     where user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub')
--       and role = 'manager'));

drop policy if exists "audit_log_insert" on public.audit_log;
create policy "audit_log_insert" on public.audit_log for insert
  with check (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));
