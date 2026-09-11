import { describe, expect, it } from 'vitest';
import { listApprovals, requestApproval, resolveApproval } from '../services/approvalsApi';
import { validateSQL } from '../services/sqlValidator';

// Sprint 9 item 2 — the browser client for /api/teams/approvals/*.

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const deps = (f: typeof fetch) => ({ fetch: f, getToken: async () => 'jwt-1' });
const report = validateSQL({ sql: 'SELECT a.id FROM a JOIN b', dialect: 'postgresql' });

describe('requestApproval', () => {
  it('posts sql + report with the Clerk token and maps 201 / 200-not-required / 409', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { required: true, id: 'r1', trigger_reasons: ['score<70'], approver_roles: ['owner', 'manager'], policy_name: 'Default' } }]);
    const r = await requestApproval({ sql: 'SELECT a.id FROM a JOIN b', report, note: 'pls' }, deps(fetchImpl));
    expect(r).toEqual({ ok: true, required: true, id: 'r1', duplicate: false, trigger_reasons: ['score<70'], approver_roles: ['owner', 'manager'], policy_name: 'Default' });
    expect(calls[0].url).toMatch(/\/api\/teams\/approvals\/request$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ sql: 'SELECT a.id FROM a JOIN b', requester_note: 'pls' });

    const notReq = await requestApproval({ sql: 'SELECT 1', report }, deps(fakeFetch([{ status: 200, body: { required: false } }]).fetchImpl));
    expect(notReq).toEqual({ ok: true, required: false });

    const conflict = await requestApproval({ sql: 'x', report }, deps(fakeFetch([{ status: 409, body: { error: 'report does not match SQL', server: { riskScore: 25, issueTypes: ['CARTESIAN_JOIN'] } } }]).fetchImpl));
    expect(conflict).toEqual({ ok: false, status: 409, error: 'report does not match SQL', server: { riskScore: 25, issueTypes: ['CARTESIAN_JOIN'] } });
  });

  it('never throws: no token → 401 result; network failure → status 0', async () => {
    expect(await requestApproval({ sql: 'x', report }, { getToken: async () => null })).toMatchObject({ ok: false, status: 401 });
    expect(await requestApproval({ sql: 'x', report }, { getToken: async () => 't', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch })).toMatchObject({ ok: false, status: 0, error: 'offline' });
  });
});

describe('listApprovals / resolveApproval', () => {
  it('lists with status/limit/cursor params and passes the inbox through', async () => {
    const inbox = { team_id: 't', my_role: 'manager', can_resolve: true, rows: [], next_cursor: null };
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: inbox }]);
    expect(await listApprovals('all', deps(fetchImpl), { limit: 10, cursor: '2026-09-11T00:00:00Z' })).toEqual(inbox);
    expect(calls[0].url).toMatch(/\/api\/teams\/approvals\?status=all&limit=10&cursor=2026-09-11T00%3A00%3A00Z$/);
    expect(await listApprovals('pending', deps(fakeFetch([{ status: 402, body: { error: 'The approval workflow is a Team feature' } }]).fetchImpl))).toEqual({ error: 'The approval workflow is a Team feature', status: 402 });
  });

  it('resolves via POST /:id/resolve and surfaces 403/409 verbatim', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { id: 'r1', status: 'approved', resolution_event_seq: 9 } }]);
    expect(await resolveApproval('r1', 'approved', '  fine  ', deps(fetchImpl))).toEqual({ ok: true, resolution_event_seq: 9 });
    expect(calls[0].url).toMatch(/\/api\/teams\/approvals\/r1\/resolve$/);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'approved', note: 'fine' });
    const sod = await resolveApproval('r1', 'approved', undefined, deps(fakeFetch([{ status: 403, body: { error: 'Separation of duties: the requester cannot resolve their own request' } }]).fetchImpl));
    expect(sod).toEqual({ ok: false, status: 403, error: 'Separation of duties: the requester cannot resolve their own request' });
  });
});
