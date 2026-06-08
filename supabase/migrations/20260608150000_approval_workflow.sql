-- Sprint 8 Part 3 — manager approval workflow.
-- Adapted to the project's Clerk/users model (NOT auth.uid()). The team-scoped
-- policy below references a `team_members` table that does NOT yet exist in this
-- schema — create it (team_id, user_id, role) before applying, OR use the
-- simpler owner policy. Flagged as a Sprint 8 reconciliation follow-up.

create table if not exists public.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  team_id           uuid not null,
  requester_id      uuid references public.users(id) on delete set null,
  approver_id       uuid references public.users(id) on delete set null,
  sql               text not null,
  ddl               text,
  dialect           text default 'postgresql',
  validation_report jsonb not null,
  risk_score        integer not null,
  status            text default 'pending',          -- pending | approved | rejected
  requester_note    text,
  approver_note     text,
  created_at        timestamptz default now(),
  resolved_at       timestamptz
);
create index if not exists approval_requests_team_idx on public.approval_requests (team_id, status);

alter table public.approval_requests enable row level security;

-- Requester sees their own; (when team_members exists) team members see team rows.
drop policy if exists "approval_requests_access" on public.approval_requests;
create policy "approval_requests_access" on public.approval_requests for all
  using (
    requester_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub')
    -- OR team_id in (select team_id from public.team_members
    --   where user_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'))
  )
  with check (
    requester_id in (select id from public.users where clerk_user_id = auth.jwt() ->> 'sub')
  );
