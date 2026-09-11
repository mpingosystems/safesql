import { describe, expect, it, vi } from 'vitest';
import { handleEvents, validationPayloadError, type EventsDeps } from '../../functions/api/teams/events';
import { handleEvidenceEvents } from '../../functions/api/teams/evidence/events';
import { handleEvidenceVerify } from '../../functions/api/teams/evidence/verify';
import type { EvidenceAccess } from '../../functions/api/teams/evidence/_shared';
import { handleValidate, type ValidateDeps } from '../../functions/api/validate';
import { hashAuditEvent, GENESIS_HASH, type AuditEventRow } from '../services/auditChain';
import { postChainEvent } from '../services/persistValidation';
import { validateSQL } from '../services/sqlValidator';

// Sprint 9 item 1 — the chain's HTTP surfaces, with mocked Supabase.

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: 'user_owner' };

function goodPayload(over: Record<string, unknown> = {}) {
  return {
    validation_id: 'v-1', sql_hash: 'ab'.repeat(32), dialect: 'postgresql', risk_score: 60,
    error_count: 0, warning_count: 1, suggestion_count: 0, issue_types: ['UNAPPROVED_SOURCE'],
    surface: 'editor', detector_version: '0.10.0', ...over,
  };
}

// A tiny query-builder mock: records the chain of calls and resolves to `result`.
function tableMock(result: { data: unknown; error?: { message: string } | null }) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'insert', 'update']) {
    chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain; };
  }
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(res);
  return { chain, calls };
}

// Build a valid chain of N rows for a team, hashed exactly as Postgres would.
async function buildChain(n: number, teamId = TEAM.id): Promise<AuditEventRow[]> {
  const rows: AuditEventRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const payload = { n: seq, kind: seq % 2 ? 'a' : 'b' };
    const base = {
      team_id: teamId, seq, event_type: (seq % 3 === 0 ? 'member_added' : 'validation_run') as AuditEventRow['event_type'],
      actor: 'user_x', actor_role: 'member', subject: `v${seq}`, payload,
      payload_canonical: `{"kind": "${payload.kind}", "n": ${seq}}`, prev_hash: prev,
      created_at: '2026-09-11T10:00:00.000Z', created_at_iso: `2026-09-11T10:00:0${seq % 10}.000000Z`,
    };
    const hash = await hashAuditEvent(base);
    rows.push({ ...base, hash });
    prev = hash;
  }
  return rows;
}

// A db mock for the evidence routes: serves chain rows with seq filters, counts and the RPC.
function evidenceDb(rows: AuditEventRow[], rpcRow?: Record<string, unknown> | null) {
  return {
    from(table: string) {
      expect(table).toBe('audit_events');
      let sel: AuditEventRow[] = [...rows];
      let desc = false; let lim: number | undefined; let onlyType = false;
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => { onlyType = cols === 'event_type'; return q; };
      q.eq = (col: string, v: unknown) => { sel = sel.filter((r) => (r as unknown as Record<string, unknown>)[col] === v); return q; };
      q.gte = (_c: string, v: number) => { sel = sel.filter((r) => r.seq >= v); return q; };
      q.lte = (_c: string, v: number) => { sel = sel.filter((r) => r.seq <= v); return q; };
      q.order = (_c: string, o: { ascending: boolean }) => { desc = !o.ascending; return q; };
      q.limit = (n: number) => { lim = n; return q; };
      q.maybeSingle = () => { const out = finish(); return Promise.resolve({ data: (out as unknown[])[0] ?? null, error: null }); };
      const finish = () => { let out = [...sel].sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq)); if (lim !== undefined) out = out.slice(0, lim); return onlyType ? out.map((r) => ({ event_type: r.event_type })) : out; };
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: finish(), error: null }).then(res);
      return q;
    },
    rpc: vi.fn(async (fn: string) => {
      expect(fn).toBe('verify_audit_chain');
      if (rpcRow === undefined) {
        // Default: agree with the TypeScript verifier on a good chain.
        const last = rows[rows.length - 1];
        return { data: [{ ok: true, checked: rows.length, first_seq: 1, last_seq: last?.seq ?? null, head_hash: last?.hash ?? null, first_bad_seq: null, expected_hash: null, actual_hash: null, reason: null }], error: null };
      }
      return { data: rpcRow ? [rpcRow] : [], error: null };
    }),
  };
}

const accessFor = (db: unknown, over: Partial<EvidenceAccess> = {}) => async (): Promise<EvidenceAccess | Response> =>
  ({ db: db as EvidenceAccess['db'], team: TEAM, role: 'auditor', clerkUserId: 'user_aud', ...over });

const get = (path: string) => new Request(`https://safesqlpro.dev${path}`, { method: 'GET', headers: { authorization: 'Bearer jwt' } });

// ── POST /api/teams/events ──────────────────────────────────────────────────

describe('POST /api/teams/events', () => {
  const post = (body: unknown, deps: Partial<EventsDeps> = {}) =>
    handleEvents(
      new Request('https://safesqlpro.dev/api/teams/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
      { callerId: async () => 'user_member', db: () => ({}) as never, ...deps },
    );

  type RpcMock = () => Promise<{ data: unknown; error: { message: string } | null }>;
  function dbWithMembership(role: string | null, rpc: RpcMock = vi.fn(async () => ({ data: 7, error: null }))) {
    return {
      from(table: string) {
        if (table === 'team_members') return tableMock({ data: role ? { team_id: TEAM.id, role } : null }).chain;
        if (table === 'teams') return tableMock({ data: role ? TEAM : null }).chain;
        throw new Error(`unexpected table ${table}`);
      },
      rpc,
    };
  }

  it('401 without a JWT; 405 on GET', async () => {
    expect((await post(goodPayload(), { callerId: async () => null })).status).toBe(401);
    const r = await handleEvents(new Request('https://x/api/teams/events', { method: 'GET' }), { callerId: async () => 'u', db: () => ({}) as never });
    expect(r.status).toBe(405);
  });

  it('accepts only validation_run from browsers', async () => {
    const r = await post({ event_type: 'member_added', payload: goodPayload() });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/only append validation_run/);
  });

  it('rejects payloads carrying SQL text or a malformed hash — validationPayloadError', () => {
    expect(validationPayloadError(goodPayload())).toBeNull();
    expect(validationPayloadError(goodPayload({ sql: 'SELECT 1' }))).toMatch(/must not contain "sql"/);
    expect(validationPayloadError(goodPayload({ DDL: 'CREATE TABLE t' }))).toMatch(/must not contain "DDL"/);
    expect(validationPayloadError(goodPayload({ sql_hash: 'nothex' }))).toMatch(/sql_hash/);
    expect(validationPayloadError(goodPayload({ risk_score: 101 }))).toMatch(/risk_score/);
    expect(validationPayloadError(goodPayload({ surface: 'api' }))).toMatch(/surface/);
    expect(validationPayloadError(goodPayload({ issue_types: 'CARTESIAN_JOIN' }))).toMatch(/issue_types/);
    expect(validationPayloadError(null)).toMatch(/object/);
  });

  it('400 on a bad payload, 413 over 8 KB, 400 on invalid JSON', async () => {
    expect((await post({ event_type: 'validation_run', payload: goodPayload({ sql: 'SELECT 1' }) })).status).toBe(400);
    expect((await post({ event_type: 'validation_run', payload: goodPayload({ pad: 'x'.repeat(9000) }) })).status).toBe(413);
    expect((await post('{nope')).status).toBe(400);
  });

  it('204 when the caller belongs to no team — nothing recorded', async () => {
    const rpc = vi.fn();
    const r = await post({ event_type: 'validation_run', payload: goodPayload() }, { db: () => dbWithMembership(null, rpc) as never });
    expect(r.status).toBe(204);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('201 with actor + role from the JWT/membership, team from membership, never from the body', async () => {
    const rpc = vi.fn(async () => ({ data: 7, error: null }));
    const r = await post({ event_type: 'validation_run', subject: 'v-1', payload: goodPayload(), team_id: 'attacker-team' }, { db: () => dbWithMembership('manager', rpc) as never });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ seq: 7, team_id: TEAM.id });
    expect(rpc).toHaveBeenCalledWith('audit_append', expect.objectContaining({
      p_team_id: TEAM.id, p_event_type: 'validation_run', p_actor: 'user_member', p_actor_role: 'manager', p_subject: 'v-1',
    }));
  });

  it('500 with the database message when the append is refused', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied for function audit_append' } }));
    const r = await post({ event_type: 'validation_run', payload: goodPayload() }, { db: () => dbWithMembership('member', rpc) as never });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/permission denied/);
  });
});

// ── persistValidation → postChainEvent (browser side) ───────────────────────

describe('postChainEvent (editor writer)', () => {
  const report = validateSQL({ sql: 'SELECT * FROM orders o JOIN items i ON i.order_id = o.id', dialect: 'postgresql', source: 'copilot' });
  const input = { appUserId: 'u', sql: 'SELECT * FROM orders o JOIN items i ON i.order_id = o.id', report, dialect: 'postgresql', detectorVersion: '0.10.0', tier: 'business' };

  it('posts a validation_run with the Clerk token and returns true on 201', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"seq":1}', { status: 201 }); }) as unknown as typeof fetch;
    const ok = await postChainEvent('cd'.repeat(32), 'v-9', input, { fetch: fetchImpl, getToken: async () => 'jwt-1' });
    expect(ok).toBe(true);
    expect(calls[0].url).toMatch(/\/api\/teams\/events$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ event_type: 'validation_run', subject: 'v-9', payload: { validation_id: 'v-9', sql_hash: 'cd'.repeat(32), surface: 'editor', source: 'copilot', tier: 'business', detector_version: '0.10.0' } });
    expect(JSON.stringify(body)).not.toContain('FROM orders');
  });

  it('never throws: no token → false, network error → false, 204 → false', async () => {
    expect(await postChainEvent('cd'.repeat(32), null, input, { getToken: async () => null })).toBe(false);
    expect(await postChainEvent('cd'.repeat(32), null, input, { getToken: async () => 't', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch })).toBe(false);
    expect(await postChainEvent('cd'.repeat(32), null, input, { getToken: async () => 't', fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch })).toBe(false);
  });
});

// ── GET /api/teams/evidence/events ──────────────────────────────────────────

describe('GET /api/teams/evidence/events', () => {
  it('propagates the access decision (401 / 402 / 404) unchanged', async () => {
    for (const status of [401, 402, 404]) {
      const r = await handleEvidenceEvents(get('/api/teams/evidence/events'), { access: async () => new Response('{}', { status }) });
      expect(r.status).toBe(status);
    }
  });

  it('returns unmodified rows, pages with cursor, and whole-chain counts', async () => {
    const rows = await buildChain(7);
    const db = evidenceDb(rows);
    const r1 = await (await handleEvidenceEvents(get('/api/teams/evidence/events?limit=3'), { access: accessFor(db) })).json();
    expect(r1.rows.map((r: AuditEventRow) => r.seq)).toEqual([1, 2, 3]);
    expect(r1.rows[0]).toEqual(rows[0]);                          // byte-for-byte the stored row
    expect(r1.next_cursor).toBe(3);
    expect(r1.head).toEqual({ seq: 7, hash: rows[6].hash, created_at_iso: rows[6].created_at_iso });
    expect(r1.counts_by_type.validation_run).toBe(5);
    expect(r1.counts_by_type.member_added).toBe(2);
    const r2 = await (await handleEvidenceEvents(get('/api/teams/evidence/events?limit=3&cursor=3'), { access: accessFor(db) })).json();
    expect(r2.rows.map((r: AuditEventRow) => r.seq)).toEqual([4, 5, 6]);
    const r3 = await (await handleEvidenceEvents(get('/api/teams/evidence/events?limit=3&cursor=6'), { access: accessFor(db) })).json();
    expect(r3.rows.map((r: AuditEventRow) => r.seq)).toEqual([7]);
    expect(r3.next_cursor).toBeNull();
  });

  it('filters by type and range; rejects bad params', async () => {
    const rows = await buildChain(7);
    const db = evidenceDb(rows);
    const t = await (await handleEvidenceEvents(get('/api/teams/evidence/events?type=member_added'), { access: accessFor(db) })).json();
    expect(t.rows.map((r: AuditEventRow) => r.seq)).toEqual([3, 6]);
    const rng = await (await handleEvidenceEvents(get('/api/teams/evidence/events?from=2&to=4'), { access: accessFor(db) })).json();
    expect(rng.rows.map((r: AuditEventRow) => r.seq)).toEqual([2, 3, 4]);
    expect((await handleEvidenceEvents(get('/api/teams/evidence/events?type=nope'), { access: accessFor(db) })).status).toBe(400);
    expect((await handleEvidenceEvents(get('/api/teams/evidence/events?from=5&to=2'), { access: accessFor(db) })).status).toBe(400);
    expect((await handleEvidenceEvents(get('/api/teams/evidence/events?limit=abc'), { access: accessFor(db) })).status).toBe(400);
  });
});

// ── GET /api/teams/evidence/verify ──────────────────────────────────────────

describe('GET /api/teams/evidence/verify', () => {
  it('runs both verifiers on a good chain and reports agree=true', async () => {
    const rows = await buildChain(5);
    const db = evidenceDb(rows);
    const r = await handleEvidenceVerify(get('/api/teams/evidence/verify'), { access: accessFor(db) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ team_id: TEAM.id, from_seq: 1, to_seq: 5, agree: true, counts: { events: 5 } });
    expect(j.db).toMatchObject({ ok: true, checked: 5, headHash: rows[4].hash });
    expect(j.local).toEqual({ ok: true, checked: 5, firstSeq: 1, lastSeq: 5, headHash: rows[4].hash });
    expect(db.rpc).toHaveBeenCalledWith('verify_audit_chain', { p_team_id: TEAM.id, p_from_seq: 1, p_to_seq: 5 });
    expect(typeof j.checked_at).toBe('string');
  });

  it('agree=false (still HTTP 200) when the database verifier disagrees with the local one', async () => {
    const rows = await buildChain(4);
    const db = evidenceDb(rows, { ok: false, checked: 2, first_seq: 1, last_seq: 2, head_hash: rows[1].hash, first_bad_seq: 3, expected_hash: 'aa'.repeat(32), actual_hash: rows[2].hash, reason: 'row hash does not match its contents' });
    const j = await (await handleEvidenceVerify(get('/api/teams/evidence/verify'), { access: accessFor(db) })).json();
    expect(j.agree).toBe(false);
    expect(j.local.ok).toBe(true);
    expect(j.db).toEqual({ ok: false, checked: 2, firstSeq: 1, lastSeq: 2, headHash: rows[1].hash, firstBadSeq: 3, expectedHash: 'aa'.repeat(32), actualHash: rows[2].hash, reason: 'row hash does not match its contents' });
  });

  it('catches tampering the database might miss (rows edited in transit) — local says no, agree=false', async () => {
    const rows = await buildChain(4);
    rows[2].actor = 'someone_else';
    const db = evidenceDb(rows); // default RPC still says ok (as the real DB would — its rows are intact)
    const j = await (await handleEvidenceVerify(get('/api/teams/evidence/verify'), { access: accessFor(db) })).json();
    expect(j.local).toMatchObject({ ok: false, firstBadSeq: 3, reason: 'row hash does not match its contents' });
    expect(j.agree).toBe(false);
  });

  it('honours from/to, 413 on an oversized range, 200 on an empty chain', async () => {
    const rows = await buildChain(6);
    const db = evidenceDb(rows);
    const seg = await (await handleEvidenceVerify(get('/api/teams/evidence/verify?from=3&to=5'), { access: accessFor(db) })).json();
    expect(seg).toMatchObject({ from_seq: 3, to_seq: 5, agree: false }); // default RPC mock reports the whole chain; local checks 3 rows
    expect(seg.local).toMatchObject({ ok: true, checked: 3, firstSeq: 3, lastSeq: 5 });
    expect((await handleEvidenceVerify(get('/api/teams/evidence/verify?from=1&to=60000'), { access: accessFor(db) })).status).toBe(413);
    const empty = evidenceDb([], { ok: true, checked: 0 });
    const e = await (await handleEvidenceVerify(get('/api/teams/evidence/verify'), { access: accessFor(empty) })).json();
    expect(e).toMatchObject({ agree: true, head: null, counts: { events: 0 } });
    expect(e.local).toEqual({ ok: true, checked: 0 });
  });
});

// ── POST /api/validate — chain write ────────────────────────────────────────

describe('POST /api/validate records validation_run on the chain', () => {
  const SQL = 'SELECT * FROM events';
  const post = (deps: ValidateDeps) =>
    handleValidate(new Request('https://safesqlpro.dev/api/validate', { method: 'POST', headers: { authorization: 'Bearer ssk_live_x', 'content-type': 'application/json' }, body: JSON.stringify({ sql: SQL, dialect: 'postgresql' }) }), deps);
  const base: ValidateDeps = {
    authenticate: async () => ({ ok: true, plan: 'business', userId: 'u1', clerkUserId: 'user_owner', keyPrefix: 'abcdef012345' }),
    checkUsage: async () => ({ ok: true }),
  };

  it('calls recordEvent with an api: actor, the key owner, and a hash-only payload — after computing the report', async () => {
    type RecordInput = { clerkUserId: string; actor: string; eventType: string; payload: Record<string, unknown> };
    const seen: RecordInput[] = [];
    const recordEvent = async (input: RecordInput) => { seen.push(input); };
    const res = await post({ ...base, recordEvent });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input).toMatchObject({ clerkUserId: 'user_owner', actor: 'api:abcdef012345', eventType: 'validation_run' });
    expect(input.payload).toMatchObject({ surface: 'api', tier: 'business', dialect: 'postgresql', detector_version: '0.10.0', validation_id: null });
    expect(input.payload.sql_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(input.payload)).not.toContain(SQL);
    const json = await res.json();
    expect(input.payload.risk_score).toBe(json.riskScore);
  });

  it('response is byte-identical with and without the dep, and a throwing recordEvent never affects it', async () => {
    const a = await (await post(base)).text();
    const b = await (await post({ ...base, recordEvent: async () => {} })).text();
    const c = await (await post({ ...base, recordEvent: async () => { throw new Error('chain down'); } })).text();
    // processingMs differs per run; compare everything else.
    const strip = (t: string) => JSON.stringify({ ...JSON.parse(t), processingMs: 0 });
    expect(strip(b)).toBe(strip(a));
    expect(strip(c)).toBe(strip(a));
  });

  it('records nothing when the key owner is unknown (no clerkUserId)', async () => {
    const recordEvent = vi.fn(async () => {});
    await post({ ...base, authenticate: async () => ({ ok: true, plan: 'pro', userId: 'u2' }), recordEvent });
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
