-- Sprint 8 Part 1 — Slack / webhook alerting.
-- NOTE: this project authenticates with Clerk (users.clerk_user_id =
-- auth.jwt()->>'sub'), NOT Supabase Auth. The Sprint 8 prompt's auth.uid()/
-- auth.users references are adapted to the project's pattern below. Apply via
-- the Supabase SQL editor. `team_members` is referenced by later Sprint 8
-- migrations but does not yet exist — see the Sprint 8 follow-up note.

create table if not exists public.webhook_configs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  team_id      uuid,                                  -- null = personal
  webhook_url  text not null,
  webhook_type text not null default 'slack',         -- slack | teams | generic
  trigger_on   text[] not null default array['error'],-- error | warning | all
  min_severity text not null default 'error',
  active       boolean default true,
  created_at   timestamptz default now()
);
create index if not exists webhook_configs_user_idx on public.webhook_configs (user_id);

create table if not exists public.webhook_logs (
  id                uuid primary key default gen_random_uuid(),
  webhook_config_id uuid references public.webhook_configs(id) on delete cascade,
  validation_id     text,
  status            text,            -- delivered | failed
  http_status       integer,
  delivered_at      timestamptz default now()
);

alter table public.webhook_configs enable row level security;
alter table public.webhook_logs enable row level security;

drop policy if exists "webhook_configs_owner" on public.webhook_configs;
create policy "webhook_configs_owner" on public.webhook_configs for all
  using (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'))
  with check (user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'));

drop policy if exists "webhook_logs_owner_read" on public.webhook_logs;
create policy "webhook_logs_owner_read" on public.webhook_logs for select
  using (webhook_config_id in (
    select id from public.webhook_configs
    where user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub')
  ));
