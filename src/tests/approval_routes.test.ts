import { describe, expect, it } from 'vitest';
import { handleApprovalRequest, type ApprovalRequestDeps } from '../../functions/api/teams/approvals/request';
import { handleApprovalsInbox } from '../../functions/api/teams/approvals/index';
import { handleResolve, approvalIdFromPath } from '../../functions/api/teams/approvals/[id]/resolve';
import { statusForGuardError, type ApprovalAccess } from '../../functions/api/teams/approvals/_shared';
import { validateSQL } from '../services/sqlValidator';

// Sprint 9 item 2 — approvals with separation of duties, mocked Supabase.

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'team', created_by: 'user_owner' };
const POLICY = { id: 'pol-1', team_id: TEAM.id, name: 'Default', active: true, min_score: 70, detector_ids: ['UNAPPROVED_SOURCE', 'FINANCE_TAG_UNVALIDATED'], require_for_destructive: true, approver_roles: ['owner', 'manager'], created_at: '2026-09-11T00:00:00Z' };
const REQ_ID = '11111111-2222-4333-8444-555555555555';

const RISKY_SQL = 'SELECT a.id FROM a JOIN b';           // CARTESIAN_JOIN → score < 70
const CLEAN_SQL = 'SELECT id FROM users WHERE id = 1';

// In-memory Supabase: tables as arrays, a tiny filter-capable query builder, and the audit_append RPC.
function makeDb(seed: { approval_requests?: Record<string, unknown>[]; users?: Record<string, unknown>[]; members?: Record<string, unknown>[] } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    approval_policies: [POLICY],
    approval_requests: seed.approval_requests ?? [],
    users: seed.users ?? [{ id: 'uid-owner', clerk_user_id: 'user_owner', email: 'o@x.io', plan: 'team' }, { id: 'uid-member', clerk_user_id: 'user_member', email: 'm@x.io', plan: 'free' }, { id: 'uid-mgr', clerk_user_id: 'user_mgr', email: 'g@x.io', plan: 'free' }],
    team_members: seed.members ?? [{ team_id: TEAM.id, clerk_user_id: 'user_owner', email: 'o@x.io' }, { team_id: TEAM.id, clerk_user_id: 'user_member', email: 'm@x.io' }, { team_id: TEAM.id, clerk_user_id: 'user_mgr', email: 'g@x.io' }],
  };
  const chain: Array<Record<string, unknown>> = [];
  let nextId = 1;
  function from(table: string) {
    const src = tables[table] ?? (tables[table] = []);
    let rows = [...src];
    let pendingInsert: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let single = false; let orderBy: { col: string; desc: boolean } | null = null; let lim: number | undefined;
    const q: Record<string, unknown> = {};
    const filter = (fn: (r: Record<string, unknown>) => boolean) => { rows = rows.filter(fn); return q; };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => filter((r) => r[c] === v);
    q.lt = (c: string, v: string) => filter((r) => String(r[c]) < v);
    q.in = (c: string, vs: unknown[]) => filter((r) => vs.includes(r[c]));
    q.order = (c: string, o: { ascending: boolean }) => { orderBy = { col: c, desc: !o.ascending }; return q; };
    q.limit = (n: number) => { lim = n; return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.single = () => { single = true; return q; };
    q.insert = (row: Record<string, unknown>) => { pendingInsert = row; return q; };
    q.update = (patch: Record<string, unknown>) => { pendingUpdate = patch; return q; };
    const run = () => {
      if (pendingInsert) {
        const row = { id: `req-${nextId++}`, created_at: new Date(2026, 8, 11, 12, nextId).toISOString(), request_event_seq: null, resolution_event_seq: null, approver_id: null, approver_clerk_user_id: null, approver_role: null, approver_note: null, resolved_at: null, ...pendingInsert };
        src.push(row);
        return { data: single ? row : [row], error: null };
      }
      if (pendingUpdate) {
        const targets = src.filter((r) => rows.includes(r));
        // Emulate the guard's separation-of-duties rule for the "bypass" test.
        for (const t of targets) {
          if (pendingUpdate.status && pendingUpdate.approver_clerk_user_id === t.requester_clerk_user_id) {
            return { data: null, error: { message: 'separation of duties: the requester cannot resolve their own request' } };
          }
          Object.assign(t, pendingUpdate);
        }
        return { data: single ? targets[0] ?? null : targets, error: null };
      }
      let out = [...rows];
      if (orderBy) {
        const { col, desc } = orderBy;
        out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (desc ? -1 : 1));
      }
      if (lim !== undefined) out = out.slice(0, lim);
      return { data: single ? out[0] ?? null : out, error: null };
    };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res);
    return q;
  }
  return {
    from,
    tables,
    chain,
    async rpc(fn: string, args: Record<string, unknown>) {
      expect(fn).toBe('audit_append');
      chain.push({ seq: chain.length + 1, ...args });
      return { data: chain.length, error: null };
    },
  };
}

const access = (db: ReturnType<typeof makeDb>, role: string, clerkUserId: string) => async (): Promise<ApprovalAccess | Response> =>
  ({ db: db as never, team: TEAM, role: role as ApprovalAccess['role'], clerkUserId });

const reqDeps = (db: ReturnType<typeof makeDb>, role = 'member', who = 'user_member'): ApprovalRequestDeps => ({
  access: access(db, role, who),
  callerPlan: async () => 'team',
});

const postRequest = (deps: ApprovalRequestDeps, body: unknown) =>
  handleApprovalRequest(new Request('https://x/api/teams/approvals/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps);

const report = (sql: string) => validateSQL({ sql, dialect: 'postgresql', tier: 'team' });

// ── POST /api/teams/approvals/request ───────────────────────────────────────

describe('POST /api/teams/approvals/request', () => {
  it('clean query → 200 required:false, nothing written anywhere', async () => {
    const db = makeDb();
    const r = await postRequest(reqDeps(db), { sql: CLEAN_SQL, report: report(CLEAN_SQL) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ required: false, reasons: [], policy_id: null });
    expect(db.tables.approval_requests).toHaveLength(0);
    expect(db.chain).toHaveLength(0);
  });

  it('risky query → 201, row stored with policy + reasons, approval_requested on the chain with hash only', async () => {
    const db = makeDb();
    const r = await postRequest(reqDeps(db), { sql: RISKY_SQL, dialect: 'postgresql', report: report(RISKY_SQL), requester_note: 'need this for the board pack' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ required: true, status: 'pending', policy_id: 'pol-1', approver_roles: ['owner', 'manager'], request_event_seq: 1 });
    expect(j.trigger_reasons).toContain('score<70');
    const row = db.tables.approval_requests[0];
    expect(row).toMatchObject({ team_id: TEAM.id, requester_id: 'uid-member', requester_clerk_user_id: 'user_member', status: 'pending', policy_id: 'pol-1', request_event_seq: 1, sql: RISKY_SQL, requester_note: 'need this for the board pack' });
    expect(db.chain[0]).toMatchObject({ p_event_type: 'approval_requested', p_actor: 'user_member', p_actor_role: 'member', p_subject: row.id });
    const payload = db.chain[0].p_payload as Record<string, unknown>;
    expect(payload.sql_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('FROM a JOIN b');
  });

  it('409 when the client report does not match the server re-run (score or ids)', async () => {
    const db = makeDb();
    const forged = { ...report(RISKY_SQL), riskScore: 100, errors: [], warnings: [], suggestions: [] };
    const r = await postRequest(reqDeps(db), { sql: RISKY_SQL, report: forged });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.server.riskScore).toBeLessThan(70);
    expect(j.client.riskScore).toBe(100);
    expect(db.tables.approval_requests).toHaveLength(0);
  });

  it('idempotent: a second identical pending request returns the first (200, duplicate:true)', async () => {
    const db = makeDb();
    const first = await (await postRequest(reqDeps(db), { sql: RISKY_SQL, report: report(RISKY_SQL) })).json();
    const r = await postRequest(reqDeps(db), { sql: RISKY_SQL, report: report(RISKY_SQL) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ required: true, duplicate: true, id: first.id });
    expect(db.tables.approval_requests).toHaveLength(1);
    expect(db.chain).toHaveLength(1);
  });

  it('403 for auditors; 400 on missing sql/report; 405 on GET; access failures pass through', async () => {
    const db = makeDb();
    expect((await postRequest(reqDeps(db, 'auditor', 'user_aud'), { sql: RISKY_SQL, report: report(RISKY_SQL) })).status).toBe(403);
    expect((await postRequest(reqDeps(db), { report: report(RISKY_SQL) })).status).toBe(400);
    expect((await postRequest(reqDeps(db), { sql: RISKY_SQL })).status).toBe(400);
    expect((await handleApprovalRequest(new Request('https://x/api/teams/approvals/request'), reqDeps(db))).status).toBe(405);
    const denied = await postRequest({ ...reqDeps(db), access: async () => new Response('{}', { status: 401 }) }, { sql: RISKY_SQL, report: report(RISKY_SQL) });
    expect(denied.status).toBe(401);
  });
});

// ── GET /api/teams/approvals ────────────────────────────────────────────────

describe('GET /api/teams/approvals', () => {
  const pendingRow = { id: REQ_ID, team_id: TEAM.id, status: 'pending', requester_clerk_user_id: 'user_member', requester_id: 'uid-member', policy_id: 'pol-1', sql: RISKY_SQL, dialect: 'postgresql', risk_score: 25, validation_report: {}, trigger_reasons: ['score<70'], created_at: '2026-09-11T12:00:00.000Z', approver_clerk_user_id: null, approver_role: null, approver_note: null, resolved_at: null, request_event_seq: 1, resolution_event_seq: null };
  const get = (db: ReturnType<typeof makeDb>, role: string, who: string, qs = '') =>
    handleApprovalsInbox(new Request(`https://x/api/teams/approvals${qs}`, { method: 'GET' }), { access: access(db, role, who) });

  it('a manager sees can_resolve_this on others\' pending requests; the requester does not; an auditor never', async () => {
    const db = makeDb({ approval_requests: [pendingRow] });
    const mgr = await (await get(db, 'manager', 'user_mgr')).json();
    expect(mgr).toMatchObject({ my_role: 'manager', can_resolve: true });
    expect(mgr.rows[0]).toMatchObject({ id: REQ_ID, can_resolve_this: true, requester_email: 'm@x.io', approver_roles: ['owner', 'manager'] });
    const self = await (await get(db, 'owner', 'user_member')).json(); // requester who happens to be owner
    expect(self.rows[0].can_resolve_this).toBe(false);
    const aud = await (await get(db, 'auditor', 'user_aud')).json();
    expect(aud).toMatchObject({ can_resolve: false });
    expect(aud.rows[0].can_resolve_this).toBe(false);
    const member = await (await get(db, 'member', 'user_other')).json();
    expect(member.rows[0].can_resolve_this).toBe(false);
  });

  it('filters by status, validates params, pages by created_at cursor', async () => {
    const resolved = { ...pendingRow, id: '22222222-2222-4333-8444-555555555555', status: 'approved', approver_clerk_user_id: 'user_owner', approver_role: 'owner', created_at: '2026-09-11T11:00:00.000Z' };
    const db = makeDb({ approval_requests: [pendingRow, resolved] });
    expect((await (await get(db, 'owner', 'user_owner')).json()).rows.map((r: { status: string }) => r.status)).toEqual(['pending']);
    const all = await (await get(db, 'owner', 'user_owner', '?status=all')).json();
    expect(all.rows).toHaveLength(2);
    expect(all.rows[1]).toMatchObject({ status: 'approved', approver_email: 'o@x.io', can_resolve_this: false });
    const page = await (await get(db, 'owner', 'user_owner', '?status=all&limit=1')).json();
    expect(page.rows).toHaveLength(1);
    expect(page.next_cursor).toBe('2026-09-11T12:00:00.000Z');
    const page2 = await (await get(db, 'owner', 'user_owner', `?status=all&limit=1&cursor=${page.next_cursor}`)).json();
    expect(page2.rows[0].status).toBe('approved');
    expect((await get(db, 'owner', 'user_owner', '?status=nope')).status).toBe(400);
    expect((await get(db, 'owner', 'user_owner', '?cursor=yesterday')).status).toBe(400);
  });
});

// ── POST /api/teams/approvals/:id/resolve ───────────────────────────────────

describe('POST /api/teams/approvals/:id/resolve', () => {
  const pendingRow = () => ({ id: REQ_ID, team_id: TEAM.id, status: 'pending', requester_clerk_user_id: 'user_member', requester_id: 'uid-member', policy_id: 'pol-1', sql: RISKY_SQL, dialect: 'postgresql', risk_score: 25, trigger_reasons: ['score<70'], approver_clerk_user_id: null, resolved_at: null, resolution_event_seq: null });
  const resolve = (db: ReturnType<typeof makeDb>, role: string, who: string, body: unknown, id = REQ_ID) =>
    handleResolve(new Request(`https://x/api/teams/approvals/${id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { access: access(db, role, who) });

  it('a manager approves: approver recorded (id, clerk id, role), chain event appended, seq written back', async () => {
    const db = makeDb({ approval_requests: [pendingRow()] });
    const r = await resolve(db, 'manager', 'user_mgr', { decision: 'approved', note: 'ok for Q3 pack' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ id: REQ_ID, status: 'approved', approver_clerk_user_id: 'user_mgr', approver_role: 'manager', resolution_event_seq: 1 });
    const row = db.tables.approval_requests[0];
    expect(row).toMatchObject({ status: 'approved', approver_id: 'uid-mgr', approver_clerk_user_id: 'user_mgr', approver_role: 'manager', approver_note: 'ok for Q3 pack', resolution_event_seq: 1 });
    expect(typeof row.resolved_at).toBe('string');
    expect(db.chain[0]).toMatchObject({ p_event_type: 'approval_approved', p_actor: 'user_mgr', p_actor_role: 'manager', p_subject: REQ_ID });
    const payload = db.chain[0].p_payload as Record<string, unknown>;
    expect(payload).toMatchObject({ approval_id: REQ_ID, requester: 'user_member', approver: 'user_mgr', approver_role: 'manager', note_present: true, trigger_reasons: ['score<70'] });
    expect(payload.sql_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('FROM a JOIN b');
  });

  it('rejection writes approval_rejected', async () => {
    const db = makeDb({ approval_requests: [pendingRow()] });
    const j = await (await resolve(db, 'owner', 'user_owner', { decision: 'rejected' })).json();
    expect(j.status).toBe('rejected');
    expect(db.chain[0].p_event_type).toBe('approval_rejected');
    expect((db.chain[0].p_payload as Record<string, unknown>).note_present).toBe(false);
  });

  it('SEPARATION OF DUTIES: the requester cannot resolve — even as owner — 403 before any write', async () => {
    const db = makeDb({ approval_requests: [pendingRow()] });
    const r = await resolve(db, 'owner', 'user_member', { decision: 'approved' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/Separation of duties/);
    expect(db.tables.approval_requests[0].status).toBe('pending');
    expect(db.chain).toHaveLength(0);
  });

  it('ROLE: member and auditor cannot resolve (403); nothing written', async () => {
    for (const role of ['member', 'auditor']) {
      const db = makeDb({ approval_requests: [pendingRow()] });
      const r = await resolve(db, role, 'user_other', { decision: 'approved' });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/Only owner or manager/);
      expect(db.chain).toHaveLength(0);
    }
  });

  it('policy approver_roles narrows who may resolve (owner-only policy → manager gets 403)', async () => {
    const db = makeDb({ approval_requests: [pendingRow()] });
    db.tables.approval_policies[0] = { ...POLICY, approver_roles: ['owner'] };
    expect((await resolve(db, 'manager', 'user_mgr', { decision: 'approved' })).status).toBe(403);
    expect((await resolve(db, 'owner', 'user_owner', { decision: 'approved' })).status).toBe(200);
  });

  it('EXACTLY ONCE: an already-resolved request → 409 with who/when; a lost race → 409', async () => {
    const db = makeDb({ approval_requests: [{ ...pendingRow(), status: 'approved', approver_clerk_user_id: 'user_owner', resolved_at: '2026-09-11T13:00:00Z' }] });
    const r = await resolve(db, 'manager', 'user_mgr', { decision: 'rejected' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/already approved by user_owner/);
    // Race: row flips to resolved between the read and the update → update matches 0 rows.
    const db2 = makeDb({ approval_requests: [pendingRow()] });
    const origFrom = db2.from.bind(db2);
    let calls = 0;
    db2.from = ((table: string) => {
      // 1st approval_requests call = the route's read; 2nd = its UPDATE. Someone
      // else resolves the row in between, so WHERE status='pending' matches nothing.
      if (table === 'approval_requests' && ++calls === 2) db2.tables.approval_requests[0].status = 'rejected';
      return origFrom(table);
    }) as typeof db2.from;
    const r2 = await resolve(db2, 'manager', 'user_mgr', { decision: 'approved' });
    expect(r2.status).toBe(409);
    expect(db2.chain).toHaveLength(0);
  });

  it('the database guard is the backstop: a trigger refusal maps to 403/409, not 500', async () => {
    // Emulated in makeDb: an UPDATE that sets approver = requester is refused with the guard's message.
    const db = makeDb({ approval_requests: [{ ...pendingRow(), requester_clerk_user_id: 'user_mgr' }] });
    // Bypass the route's own SoD check by making the requester look different at read time…
    db.tables.approval_requests[0].requester_clerk_user_id = 'user_mgr';
    const r = await resolve(db, 'manager', 'user_mgr', { decision: 'approved' });
    expect(r.status).toBe(403); // route check fires first here; guard mapping covered below
    expect(statusForGuardError('separation of duties: the requester cannot resolve their own request')).toBe(403);
    expect(statusForGuardError('only an owner or manager may resolve an approval request (got member)')).toBe(403);
    expect(statusForGuardError('a resolved approval request is immutable')).toBe(409);
    expect(statusForGuardError('resolution_event_seq is already recorded (4) and cannot change')).toBe(409);
    expect(statusForGuardError('connection reset')).toBe(500);
  });

  it('404 for another team\'s id or a non-UUID; 400 on a bad decision', async () => {
    const db = makeDb({ approval_requests: [{ ...pendingRow(), team_id: 'other-team' }] });
    expect((await resolve(db, 'owner', 'user_owner', { decision: 'approved' })).status).toBe(404);
    expect((await resolve(db, 'owner', 'user_owner', { decision: 'approved' }, 'not-a-uuid')).status).toBe(400);
    const db2 = makeDb({ approval_requests: [pendingRow()] });
    expect((await resolve(db2, 'owner', 'user_owner', { decision: 'maybe' })).status).toBe(400);
    expect(approvalIdFromPath(`/api/teams/approvals/${REQ_ID}/resolve`)).toBe(REQ_ID);
    expect(approvalIdFromPath('/api/teams/approvals/x/resolve')).toBeNull();
  });
});
