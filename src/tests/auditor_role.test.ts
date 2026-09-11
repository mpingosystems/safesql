import { describe, expect, it } from 'vitest';
import { handleRoleChange, roleChangeError, type RoleChangeDeps } from '../../functions/api/teams/member/role';
import { handleEvents } from '../../functions/api/teams/events';
import { ASSIGNABLE_ROLES, READ_ONLY_ROLES, isWriteRole } from '../../functions/api/teams/_shared';
import { changeMemberRole } from '../services/teamRolesApi';

// Sprint 9 item 3 — the auditor role: a read-only seat, and the membership
// chain events that let the evidence trail answer "who had access when".

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: 'user_owner' };

// In-memory Supabase with team_members / teams / users tables and the audit_append RPC.
function makeDb(members: Array<{ clerk_user_id: string; role: string; email: string }>) {
  const tables: Record<string, Record<string, unknown>[]> = {
    teams: [TEAM],
    team_members: members.map((m, i) => ({ id: `m${i}`, team_id: TEAM.id, ...m })),
    users: members.map((m, i) => ({ id: `u${i}`, clerk_user_id: m.clerk_user_id, email: m.email, plan: m.role === 'auditor' ? 'free' : 'business' })),
  };
  const chain: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const src = tables[table] ?? [];
    let rows = [...src];
    let single = false;
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.update = (p: Record<string, unknown>) => { patch = p; return q; };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      if (patch) { for (const r of rows) Object.assign(r, patch); return Promise.resolve({ data: rows, error: null }).then(res); }
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(res);
    };
    return q;
  }
  return {
    from, tables, chain,
    async rpc(fn: string, args: Record<string, unknown>) { expect(fn).toBe('audit_append'); chain.push(args); return { data: chain.length, error: null }; },
  };
}

const deps = (db: ReturnType<typeof makeDb>, caller: string): RoleChangeDeps => ({ callerId: async () => caller, db: () => db as never });
const patch = (db: ReturnType<typeof makeDb>, caller: string, body: unknown) =>
  handleRoleChange(new Request('https://x/api/teams/member/role', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps(db, caller));

const SEATS = [
  { clerk_user_id: 'user_owner', role: 'owner', email: 'o@x.io' },
  { clerk_user_id: 'user_mgr', role: 'manager', email: 'g@x.io' },
  { clerk_user_id: 'user_mgr2', role: 'manager', email: 'g2@x.io' },
  { clerk_user_id: 'user_member', role: 'member', email: 'm@x.io' },
  { clerk_user_id: 'user_aud', role: 'auditor', email: 'a@x.io' },
];

describe('role vocabulary', () => {
  it('auditor is read-only and assignable; owner is neither read-only nor assignable', () => {
    expect([...READ_ONLY_ROLES]).toEqual(['auditor']);
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(['auditor', 'manager', 'member']);
    expect(isWriteRole('auditor')).toBe(false);
    for (const r of ['owner', 'manager', 'member']) expect(isWriteRole(r)).toBe(true);
  });
});

describe('roleChangeError matrix', () => {
  const t = (role: string, id = 'user_t') => ({ clerk_user_id: id, role });
  it('owner may set manager/member/auditor on anyone but themselves and never on the owner row', () => {
    expect(roleChangeError('owner', 'user_owner', t('member'), 'auditor')).toBeNull();
    expect(roleChangeError('owner', 'user_owner', t('auditor'), 'manager')).toBeNull();
    expect(roleChangeError('owner', 'user_owner', t('manager'), 'member')).toBeNull();
    expect(roleChangeError('owner', 'user_owner', t('member', 'user_owner'), 'auditor')).toMatchObject({ status: 403, error: /own role/ });
    expect(roleChangeError('owner', 'user_owner', t('owner'), 'member')).toMatchObject({ status: 403 });
    expect(roleChangeError('owner', 'user_owner', t('member'), 'owner')).toMatchObject({ status: 400 });
    expect(roleChangeError('owner', 'user_owner', t('auditor'), 'auditor')).toMatchObject({ status: 409 });
  });
  it('manager may set member/auditor on members and auditors only', () => {
    expect(roleChangeError('manager', 'user_mgr', t('member'), 'auditor')).toBeNull();
    expect(roleChangeError('manager', 'user_mgr', t('auditor'), 'member')).toBeNull();
    expect(roleChangeError('manager', 'user_mgr', t('member'), 'manager')).toMatchObject({ status: 403, error: /promote to manager/ });
    expect(roleChangeError('manager', 'user_mgr', t('manager'), 'member')).toMatchObject({ status: 403, error: /manager's role/ });
  });
  it('member and auditor may change nothing', () => {
    expect(roleChangeError('member', 'user_member', t('member'), 'auditor')).toMatchObject({ status: 403 });
    expect(roleChangeError('auditor', 'user_aud', t('member'), 'auditor')).toMatchObject({ status: 403 });
  });
});

describe('PATCH /api/teams/member/role', () => {
  it('owner demotes a member to auditor: row updated, paid plan revoked, member_role_changed on the chain', async () => {
    const db = makeDb(SEATS);
    const r = await patch(db, 'user_owner', { clerk_user_id: 'user_member', role: 'auditor' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, member: { clerk_user_id: 'user_member', role: 'auditor' }, from: 'member', plan_changed: 'revoked', event_seq: 1 });
    expect(db.tables.team_members.find((m) => m.clerk_user_id === 'user_member')?.role).toBe('auditor');
    expect(db.tables.users.find((u) => u.clerk_user_id === 'user_member')?.plan).toBe('free');
    expect(db.chain[0]).toMatchObject({ p_event_type: 'member_role_changed', p_actor: 'user_owner', p_actor_role: 'owner', p_subject: 'user_member', p_payload: { from: 'member', to: 'auditor', plan_changed: 'revoked' } });
  });

  it('promoting an auditor to member grants the team plan', async () => {
    const db = makeDb(SEATS);
    const j = await (await patch(db, 'user_mgr', { clerk_user_id: 'user_aud', role: 'member' })).json();
    expect(j).toMatchObject({ from: 'auditor', plan_changed: 'granted' });
    expect(db.tables.users.find((u) => u.clerk_user_id === 'user_aud')?.plan).toBe('business');
  });

  it('manager cannot touch another manager or promote; auditor cannot change anyone; unknown target 404', async () => {
    const db = makeDb(SEATS);
    expect((await patch(db, 'user_mgr', { clerk_user_id: 'user_mgr2', role: 'member' })).status).toBe(403);
    expect((await patch(db, 'user_mgr', { clerk_user_id: 'user_member', role: 'manager' })).status).toBe(403);
    expect((await patch(db, 'user_aud', { clerk_user_id: 'user_member', role: 'auditor' })).status).toBe(403);
    expect((await patch(db, 'user_owner', { clerk_user_id: 'ghost', role: 'auditor' })).status).toBe(404);
    expect((await patch(db, 'user_owner', { clerk_user_id: 'user_member', role: 'god' })).status).toBe(400);
    expect(db.chain).toHaveLength(0);
  });

  it('401 without a JWT; 405 on POST; caller outside any team → 403', async () => {
    const db = makeDb(SEATS);
    expect((await handleRoleChange(new Request('https://x/api/teams/member/role', { method: 'PATCH', body: '{}' }), { callerId: async () => null, db: () => db as never })).status).toBe(401);
    expect((await handleRoleChange(new Request('https://x/api/teams/member/role', { method: 'POST', body: '{}' }), deps(db, 'user_owner'))).status).toBe(405);
    expect((await patch(db, 'stranger', { clerk_user_id: 'user_member', role: 'auditor' })).status).toBe(403);
  });
});

describe('auditor is read-only on the browser event writer', () => {
  it('POST /api/teams/events → 403 for an auditor, 201 for a member', async () => {
    const payload = { validation_id: null, sql_hash: 'ab'.repeat(32), dialect: 'postgresql', risk_score: 90, error_count: 0, warning_count: 0, suggestion_count: 1, issue_types: ['SELECT_STAR_EXPENSIVE'], surface: 'editor', detector_version: '0.10.0' };
    const post = (who: string) => {
      const db = makeDb(SEATS);
      return handleEvents(new Request('https://x/api/teams/events', { method: 'POST', body: JSON.stringify({ event_type: 'validation_run', payload }) }), { callerId: async () => who, db: () => db as never });
    };
    const aud = await post('user_aud');
    expect(aud.status).toBe(403);
    expect((await aud.json()).error).toMatch(/read-only/);
    expect((await post('user_member')).status).toBe(201);
  });
});

describe('changeMemberRole (browser client)', () => {
  it('PATCHes with the Clerk token and maps the response; never throws', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, member: { role: 'auditor' }, from: 'member', plan_changed: 'revoked', event_seq: 12 }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await changeMemberRole('user_member', 'auditor', { fetch: f, getToken: async () => 'jwt' });
    expect(r).toEqual({ ok: true, role: 'auditor', from: 'member', plan_changed: 'revoked', event_seq: 12 });
    expect(calls[0].url).toMatch(/\/api\/teams\/member\/role$/);
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ clerk_user_id: 'user_member', role: 'auditor' });
    expect(await changeMemberRole('x', 'auditor', { getToken: async () => null })).toMatchObject({ ok: false, status: 401 });
    const denied = (async () => new Response(JSON.stringify({ error: 'Only the owner can promote to manager' }), { status: 403 })) as unknown as typeof fetch;
    expect(await changeMemberRole('x', 'manager', { fetch: denied, getToken: async () => 'jwt' })).toEqual({ ok: false, status: 403, error: 'Only the owner can promote to manager' });
  });
});
