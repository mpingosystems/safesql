import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  AUDIT_EVENT_TYPES,
  GENESIS_HASH,
  appendAuditEvent,
  auditRecordOf,
  hashAuditEvent,
  isAuditEventType,
  validationRunPayload,
  verifyChain,
  type AuditEventRow,
  type ChainWriter,
} from '../src/services/auditChain';
import { validateSQL } from '../src/services/sqlValidator';

// Sprint 9 item 1 — the chain, verified end to end against a REAL Postgres
// (PGlite + pgcrypto) running the committed migration, so the TypeScript
// verifier is proven on rows the database trigger actually produced. Lives in
// cli/ because it needs Node modules (tsconfig.app.json has no Node types).

const MIG = join(__dirname, '..', 'supabase', 'migrations');
const sql = (f: string) => readFileSync(join(MIG, f), 'utf8');

let db: PGlite;
let teamId: string;

async function rows(): Promise<AuditEventRow[]> {
  const r = await db.query<AuditEventRow>(`SELECT * FROM public.audit_events WHERE team_id = $1 ORDER BY seq`, [teamId]);
  // PGlite returns bigint columns as number; created_at as Date — coerce to the API's wire shape.
  return r.rows.map((x) => ({ ...x, seq: Number(x.seq), created_at: String(x.created_at) }));
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA IF NOT EXISTS extensions; CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.teams (id uuid primary key default gen_random_uuid(), name text, slug text unique, plan text not null default 'team', created_by text not null, created_at timestamptz default now(), updated_at timestamptz default now());
    CREATE TABLE public.team_members (id uuid primary key default gen_random_uuid(), team_id uuid references public.teams(id), clerk_user_id text not null, role text not null default 'member', email text not null);
    CREATE TABLE public.audit_log (id uuid primary key default gen_random_uuid(), team_id uuid, event_type text, event_data jsonb, created_at timestamptz default now());
    ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.teams (name, slug, created_by) VALUES ('Acme', 'acme', 'user_owner');
  `);
  await db.exec(sql('20260911000000_compliance_audit_events.sql'));
  teamId = (await db.query<{ id: string }>(`SELECT id FROM public.teams`)).rows[0].id;
  // PGlite boot + migration can exceed the 10 s default under full-suite
  // parallel contention (same as sandbox check_constraint.test.ts).
}, 60_000);

// A ChainWriter over PGlite that speaks the same rpc() contract as supabase-js.
function pgliteWriter(): ChainWriter {
  return {
    async rpc(fn, args) {
      try {
        const r = await db.query<{ v: number }>(
          `SELECT public.${fn}($1, $2, $3, $4, $5, $6::jsonb) AS v`,
          [args.p_team_id, args.p_event_type, args.p_actor, args.p_actor_role, args.p_subject, JSON.stringify(args.p_payload)],
        );
        return { data: Number(r.rows[0].v), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}

describe('appendAuditEvent + database trigger', () => {
  it('appends through the audit_append RPC and returns gapless seqs', async () => {
    const w = pgliteWriter();
    const s1 = await appendAuditEvent(w, { teamId, eventType: 'validation_run', actor: 'user_a', actorRole: 'member', subject: 'v1', payload: { score: 25, issues: ['CARTESIAN_JOIN'] } });
    const s2 = await appendAuditEvent(w, { teamId, eventType: 'member_added', actor: 'user_owner', actorRole: 'owner', subject: 'user_b', payload: { role: 'member', email: 'b@x.io' } });
    const s3 = await appendAuditEvent(w, { teamId, eventType: 'plan_changed', actor: 'system:stripe', payload: { from: 'team', to: 'business', nested: { z: 1, a: [1, 2] } } });
    expect([s1, s2, s3]).toEqual([1, 2, 3]);
    const all = await rows();
    expect(all[0].prev_hash).toBe(GENESIS_HASH);
    expect(all[1].prev_hash).toBe(all[0].hash);
    expect(all[2].actor_role).toBeNull();
  });

  it('refuses unknown event types before reaching the database, and the database refuses them too', async () => {
    await expect(appendAuditEvent(pgliteWriter(), { teamId, eventType: 'made_up' as never, actor: 'x', payload: {} })).rejects.toThrow(/unknown event type/);
    const w = pgliteWriter();
    const r = await w.rpc('audit_append', { p_team_id: teamId, p_event_type: 'made_up', p_actor: 'x', p_actor_role: null, p_subject: null, p_payload: {} });
    expect(r.error?.message).toMatch(/audit_events_type_known/);
  });

  it('surfaces RPC errors as thrown errors with the database message', async () => {
    const failing: ChainWriter = { rpc: async () => ({ data: null, error: { message: 'permission denied for function audit_append' } }) };
    await expect(appendAuditEvent(failing, { teamId, eventType: 'validation_run', actor: 'x', payload: {} })).rejects.toThrow(/permission denied/);
  });
});

describe('hashAuditEvent / verifyChain agree with Postgres', () => {
  it('recomputes every stored hash from stored fields only (Web Crypto and node:crypto agree)', async () => {
    for (const r of await rows()) {
      expect(await hashAuditEvent(r)).toBe(r.hash);
      expect(createHash('sha256').update(auditRecordOf(r), 'utf8').digest('hex')).toBe(r.hash);
    }
  });

  it('verifies the whole chain and matches verify_audit_chain()', async () => {
    const all = await rows();
    const local = await verifyChain(all);
    const dbv = (await db.query<{ ok: boolean; checked: number; head_hash: string }>(`SELECT ok, checked, head_hash FROM public.verify_audit_chain($1)`, [teamId])).rows[0];
    expect(local).toEqual({ ok: true, checked: 3, firstSeq: 1, lastSeq: 3, headHash: all[2].hash });
    expect(dbv.ok).toBe(true);
    expect(Number(dbv.checked)).toBe(3);
    expect(dbv.head_hash).toBe(local.headHash);
  });

  it('verifies a mid-chain segment using the stored prev_hash as anchor', async () => {
    const all = await rows();
    expect(await verifyChain(all.slice(1))).toMatchObject({ ok: true, checked: 2, firstSeq: 2, lastSeq: 3 });
    expect(await verifyChain([])).toEqual({ ok: true, checked: 0 });
  });

  it('detects every tamper the SQL verifier detects, with the same reason', async () => {
    const all = await rows();
    const clone = () => all.map((r) => ({ ...r, payload: JSON.parse(JSON.stringify(r.payload)) }));

    let t = clone(); t[1].payload.role = 'owner'; // edit JSON but not canonical
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 2, reason: 'payload_canonical does not represent payload' });

    t = clone(); t[1].payload_canonical = t[1].payload_canonical.replace('"member"', '"owner"'); t[1].payload.role = 'owner'; // edit both, hash stale
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 2, reason: 'row hash does not match its contents' });

    t = clone(); t[1].actor = 'someone_else';
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 2, reason: 'row hash does not match its contents' });

    t = clone(); t.splice(1, 1); // remove a row → gap
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 3, reason: 'gap in seq' });

    t = clone(); t[2].prev_hash = t[0].hash; // relink around a row
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 3, reason: 'prev_hash does not match previous row hash', expectedHash: all[1].hash, actualHash: all[0].hash });

    t = clone(); t[0].prev_hash = 'f'.repeat(64);
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'genesis prev_hash is not zero' });

    t = clone(); t[0].hash = 'nothex';
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'hash or prev_hash is not 64 hex characters' });

    t = clone(); t[0].payload_canonical = '{not json';
    expect(await verifyChain(t)).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'payload_canonical is not valid JSON' });
  });

  it('is indifferent to JSON key order in `payload` (jsonb has none) but not to values', async () => {
    const all = await rows();
    const reordered = all.map((r) => ({ ...r, payload: Object.fromEntries(Object.entries(r.payload).reverse()) }));
    expect((await verifyChain(reordered)).ok).toBe(true);
  });

  it('the database refuses edits the verifier would have caught', async () => {
    await expect(db.query(`UPDATE public.audit_events SET payload = '{"x":1}'::jsonb WHERE team_id = $1 AND seq = 1`, [teamId])).rejects.toThrow(/append-only/);
  });
});

describe('validationRunPayload', () => {
  const report = validateSQL({ sql: 'SELECT * FROM events e JOIN sessions s ON s.event_id = e.id', dialect: 'postgresql', source: 'cursor' });

  it('carries counts, sorted unique issue ids, source and provenance — and never the SQL', () => {
    const p = validationRunPayload(report, { validationId: 'v-1', sqlHash: 'ab'.repeat(32), dialect: 'postgresql', surface: 'editor', detectorVersion: '0.10.0', tier: 'business', dbt: { currentModel: 'stg_orders', sensitiveTagged: 1 } });
    expect(p).toMatchObject({ validation_id: 'v-1', sql_hash: 'ab'.repeat(32), dialect: 'postgresql', risk_score: report.riskScore, surface: 'editor', source: 'cursor', tier: 'business', detector_version: '0.10.0', dbt: { current_model: 'stg_orders', sensitive_tagged: 1 } });
    expect(p.issue_types).toEqual([...new Set(p.issue_types)].sort());
    expect(p.issue_types.length).toBeGreaterThan(0);
    expect(p.error_count + p.warning_count + p.suggestion_count).toBe(report.errors.length + report.warnings.length + report.suggestions.length);
    // Issue ids legitimately contain words like JOIN; the query TEXT must not appear.
    const text = JSON.stringify(p);
    expect(text).not.toContain('FROM events');
    expect(text).not.toContain('s.event_id = e.id');
    expect(Object.keys(p)).not.toContain('sql');
    expect(Object.keys(p)).not.toContain('ddl');
  });

  it('omits optional fields cleanly and defaults validation_id to null', () => {
    const bare = validateSQL({ sql: 'SELECT 1', dialect: 'postgresql' });
    const p = validationRunPayload(bare, { sqlHash: 'cd'.repeat(32), dialect: 'postgresql', surface: 'api', detectorVersion: '0.10.0' });
    expect(p).toEqual({ validation_id: null, sql_hash: 'cd'.repeat(32), dialect: 'postgresql', risk_score: 100, error_count: 0, warning_count: 0, suggestion_count: 0, issue_types: [], surface: 'api', detector_version: '0.10.0' });
  });
});

describe('vocabulary', () => {
  it('matches the database CHECK constraint (16 types) and the guard agrees', () => {
    expect(AUDIT_EVENT_TYPES).toHaveLength(16);
    const inSql = [...sql('20260911000000_compliance_audit_events.sql').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const t of AUDIT_EVENT_TYPES) expect(inSql).toContain(t);
    expect(isAuditEventType('plan_changed')).toBe(true);
    expect(isAuditEventType('PLAN_CHANGED')).toBe(false);
    expect(isAuditEventType(42)).toBe(false);
  });
});
