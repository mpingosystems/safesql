-- Sprint 8 Part 5 — team custom rules (Business tier).
-- Clerk-adapted; the team-scoped policy references `team_members` (not yet
-- present) — a created_by-owner policy is used meanwhile. Flagged for Sprint 8
-- reconciliation.

create table if not exists public.custom_rules (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null,
  name        text not null,
  description text,
  rule_type   text not null,    -- required_filter | forbidden_table |
                                -- required_join_condition | forbidden_pattern |
                                -- required_column_qualification
  config      jsonb not null,
  severity    text default 'warning',
  active      boolean default true,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz default now()
);
create index if not exists custom_rules_team_idx on public.custom_rules (team_id, active);

alter table public.custom_rules enable row level security;

drop policy if exists "custom_rules_owner" on public.custom_rules;
create policy "custom_rules_owner" on public.custom_rules for all
  using (created_by in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'))
  with check (created_by in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));
-- (Business: whole team manages rules — enable once team_members exists)
-- create policy "custom_rules_team" on public.custom_rules for all
--   using (team_id in (select team_id from public.team_members
--     where user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub')));
