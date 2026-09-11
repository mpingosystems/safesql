import { describe, expect, it, vi, beforeEach } from 'vitest';

// Sprint 9 item 3 — the legacy membership routes (accept / member / invite /
// audit) with the auditor role and the new membership chain events. These
// routes are Env-bound (admin(env) + Clerk JWKS), so `admin` and `callerId`
// are mocked here; everything else in _shared runs for real.

let caller: string | null = 'user_owner';
let db: ReturnType<typeof makeDb>;

vi.mock('../../functions/api/teams/_shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../functions/api/teams/_shared')>();
  return {
    ...real,
    admin: () => db as never,
    callerId: async () => caller,
    sendEmail: async () => false,
  };
});

import { onRequestPost as acceptPost } from '../../functions/api/teams/accept';
import { onRequestDelete as memberDelete } from '../../functions/api/teams/member';
import { onRequestPost as invitePost } from '../../functions/api/teams/invite';
import { onRequestGet as auditGet } from '../../functions/api/teams/audit';

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: 'user_owner', created_at: '2026-09-01T00:00:00Z' };
const ENV = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y', SITE_URL: 'https://safesqlpro.dev' } as never;

function makeDb(seed: { members?: Record<string, unknown>[]; invitations?: Record<string, unknown>[]; users?: Record<string, unknown>[] }) {
  const tables: Record<string, Record<string, unknown>[]> = {
    teams: [TEAM],
    team_members: seed.members ?? [],
    team_invitations: seed.invitations ?? [],
    users: seed.users ?? [],
    validations: [],
  };
  const chain: Array<Record<string, unknown>> = [];
  let nextId = 100;
  function from(table: string) {
    const src = tables[table] ?? (tables[table] = []);
    let rows = [...src];
    let single = false; let countOnly = false; let orderDesc = false; let lim: number | undefined;
    let ins: Record<string, unknown> | null = null; let patch: Record<string, unknown> | null = null; let del = false;
    const q: Record<string, unknown> = {};
    q.select = (_c?: string, o?: { count?: string; head?: boolean }) => { if (o?.head) countOnly = true; return q; };
    q.eq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; };
    q.in = (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; };
    q.is = (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q; };
    q.gt = (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) > v); return q; };
    q.gte = (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) >= v); return q; };
    q.lt = (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) < v); return q; };
    q.order = (_c: string, o: { ascending: boolean }) => { orderDesc = !o.ascending; return q; };
    q.limit = (n: number) => { lim = n; return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.single = () => { single = true; return q; };
    q.insert = (r: Record<string, unknown>) => { ins = r; return q; };
    q.update = (p: Record<string, unknown>) => { patch = p; return q; };
    q.delete = () => { del = true; return q; };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      let out: unknown;
      if (ins) { const row = { id: `id${nextId++}`, created_at: new Date().toISOString(), ...ins }; src.push(row); out = { data: single ? row : [row], error: null }; }
      else if (patch) { for (const r of rows) Object.assign(r, patch); out = { data: rows, error: null }; }
      else if (del) { for (const r of rows) src.splice(src.indexOf(r), 1); out = { data: null, error: null }; }
      else if (countOnly) out = { count: rows.length, data: null, error: null };
      else { let o = [...rows]; if (orderDesc) o.reverse(); if (lim !== undefined) o = o.slice(0, lim); out = { data: single ? o[0] ?? null : o, error: null }; }
      return Promise.resolve(out).then(res);
    };
    return q;
  }
  return { from, tables, chain, async rpc(fn: string, args: Record<string, unknown>) { expect(fn).toBe('audit_append'); chain.push(args); return { data: chain.length, error: null }; } };
}

const post = (fn: (c: { request: Request; env: never }) => Promise<Response>, path: string, body: unknown, method = 'POST') =>
  fn({ request: new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) }), env: ENV });

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

beforeEach(() => { caller = 'user_owner'; });

describe('POST /api/teams/accept — auditor seats without the paid plan, member_added on the chain', () => {
  it('auditor invitation: seated as auditor, users.plan untouched, chain event with plan_granted:false', async () => {
    db = makeDb({
      members: [{ id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' }],
      invitations: [{ id: 'inv1', team_id: TEAM.id, email: 'a@x.io', role: 'auditor', token: 'tok-aud', expires_at: FUTURE, accepted_at: null, invited_by: 'user_owner' }],
      users: [{ id: 'ua', clerk_user_id: 'user_aud', email: 'a@x.io', plan: 'free' }],
    });
    caller = 'user_aud';
    const r = await post(acceptPost as never, '/api/teams/accept', { token: 'tok-aud' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ role: 'auditor', planGranted: false, plan: null });
    expect(db.tables.team_members.find((m) => m.clerk_user_id === 'user_aud')).toMatchObject({ role: 'auditor' });
    expect(db.tables.users[0].plan).toBe('free');
    expect(db.chain[0]).toMatchObject({ p_event_type: 'member_added', p_actor: 'user_aud', p_actor_role: 'auditor', p_subject: 'user_aud', p_payload: { member: 'user_aud', role: 'auditor', invited_by: 'user_owner', invitation_id: 'inv1', plan_granted: false } });
  });

  it('member invitation still grants the team plan, and is chained with plan_granted:true', async () => {
    db = makeDb({
      members: [{ id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' }],
      invitations: [{ id: 'inv2', team_id: TEAM.id, email: 'm@x.io', role: 'member', token: 'tok-mem', expires_at: FUTURE, accepted_at: null, invited_by: 'user_owner' }],
      users: [{ id: 'um', clerk_user_id: 'user_member', email: 'm@x.io', plan: 'free' }],
    });
    caller = 'user_member';
    const j = await (await post(acceptPost as never, '/api/teams/accept', { token: 'tok-mem' })).json();
    expect(j).toMatchObject({ role: 'member', planGranted: true, plan: 'business' });
    expect(db.tables.users[0].plan).toBe('business');
    expect(db.chain[0]).toMatchObject({ p_event_type: 'member_added', p_payload: { role: 'member', plan_granted: true } });
  });
});

describe('DELETE /api/teams/member — auditor parity + member_removed on the chain', () => {
  const seats = () => [
    { id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' },
    { id: 'm1', team_id: TEAM.id, clerk_user_id: 'user_member', role: 'member', email: 'm@x.io' },
    { id: 'm2', team_id: TEAM.id, clerk_user_id: 'user_aud', role: 'auditor', email: 'a@x.io' },
  ];
  it('an auditor cannot remove others (403) but may leave; owner removing the auditor is chained', async () => {
    db = makeDb({ members: seats(), users: [{ id: 'ua', clerk_user_id: 'user_aud', plan: 'free' }, { id: 'um', clerk_user_id: 'user_member', plan: 'business' }] });
    caller = 'user_aud';
    expect((await post(memberDelete as never, '/api/teams/member', { clerk_user_id: 'user_member' }, 'DELETE')).status).toBe(403);
    const leave = await post(memberDelete as never, '/api/teams/member', { clerk_user_id: 'user_aud' }, 'DELETE');
    expect(leave.status).toBe(200);
    expect(db.chain[0]).toMatchObject({ p_event_type: 'member_removed', p_actor: 'user_aud', p_actor_role: 'auditor', p_subject: 'user_aud', p_payload: { role: 'auditor', self_removal: true } });
    db = makeDb({ members: seats(), users: [{ id: 'um', clerk_user_id: 'user_member', plan: 'business' }] });
    caller = 'user_owner';
    const j = await (await post(memberDelete as never, '/api/teams/member', { clerk_user_id: 'user_member' }, 'DELETE')).json();
    expect(j).toMatchObject({ ok: true, removed: { role: 'member' }, planRevoked: true });
    expect(db.chain[0]).toMatchObject({ p_event_type: 'member_removed', p_actor: 'user_owner', p_actor_role: 'owner', p_subject: 'user_member', p_payload: { member: 'user_member', role: 'member', self_removal: false, plan_revoked: true } });
  });
});

describe('POST /api/teams/invite — auditor role accepted; auditors cannot invite', () => {
  it('owner invites an auditor; the invitation carries role=auditor', async () => {
    db = makeDb({ members: [{ id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' }] });
    const r = await post(invitePost as never, '/api/teams/invite', { email: 'audit@x.io', role: 'auditor' });
    expect(r.status).toBe(201);
    expect((await r.json()).invite).toMatchObject({ email: 'audit@x.io', role: 'auditor' });
    expect(db.tables.team_invitations[0]).toMatchObject({ role: 'auditor', invited_by: 'user_owner' });
  });
  it('an unknown role falls back to member; an auditor caller gets 403', async () => {
    db = makeDb({ members: [{ id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' }, { id: 'm2', team_id: TEAM.id, clerk_user_id: 'user_aud', role: 'auditor', email: 'a@x.io' }] });
    const j = await (await post(invitePost as never, '/api/teams/invite', { email: 'x@x.io', role: 'superuser' })).json();
    expect(j.invite.role).toBe('member');
    caller = 'user_aud';
    const r = await post(invitePost as never, '/api/teams/invite', { email: 'y@x.io' });
    expect(r.status).toBe(403);
  });
});

describe('GET /api/teams/audit — auditors may export', () => {
  it('can_export is true for an auditor on a Business team, false for a member', async () => {
    db = makeDb({ members: [
      { id: 'm0', team_id: TEAM.id, clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' },
      { id: 'm1', team_id: TEAM.id, clerk_user_id: 'user_member', role: 'member', email: 'm@x.io' },
      { id: 'm2', team_id: TEAM.id, clerk_user_id: 'user_aud', role: 'auditor', email: 'a@x.io' },
    ] });
    caller = 'user_aud';
    const a = await (await post(auditGet as never, '/api/teams/audit', undefined, 'GET')).json();
    expect(a.can_export).toBe(true);
    caller = 'user_member';
    const m = await (await post(auditGet as never, '/api/teams/audit', undefined, 'GET')).json();
    expect(m.can_export).toBe(false);
  });
});
