import { describe, expect, it } from 'vitest';
import {
  API_KEY_NO_TEAM_ERROR,
  requireEvidenceAccess,
  type EvidenceAccess,
} from '../../functions/api/teams/evidence/_shared';
import { handleBundleCreate } from '../../functions/api/teams/evidence/bundle';
import type { Env } from '../../functions/_shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GENESIS_HASH, hashAuditEvent, type AuditEventRow } from '../services/auditChain';
import { hashApiKey } from '../services/apiKeys';

// Sprint 9.5A-post — the evidence routes accept a SafeSQL Pro API key, so
// `safesql scan --sign` works from CI. requireEvidenceAccess is exercised
// directly with a mocked Supabase client and a stubbed JWT verifier; the last
// case runs the real bundle-create handler behind the key-derived access to
// prove the 201 end to end.

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' } as unknown as Env;
const API_KEY = 'ssk_live_0123456789abcdef0123456789abcdef';
const OWNER = 'user_owner';
const BUSINESS = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: OWNER };
const TEAM_PLAN = { ...BUSINESS, plan: 'team' };
const SIGNING_KEY = 'ab'.repeat(32);
const NOW = new Date('2026-09-20T12:00:00.000Z');

interface Fixture {
  keyRow?: { user_id: string; revoked_at: string | null; users: { plan: string; clerk_user_id: string } } | null;
  membership?: { team_id: string; role: string } | null;
  team?: typeof BUSINESS | null;
  events?: AuditEventRow[];
}

// Minimal Supabase mock: api_keys / team_members / teams for auth, and the
// evidence tables the bundle handler touches when the end-to-end case runs.
function makeDb(f: Fixture) {
  const tables = { evidence_bundles: [] as Record<string, unknown>[] };
  const chainEvents: Record<string, unknown>[] = [];
  const looked: string[] = [];
  const respond = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'single']) {
      q[m] = () => q;
    }
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
    return q;
  };
  const db = {
    from(table: string) {
      looked.push(table);
      if (table === 'api_keys') return respond(f.keyRow ?? null);
      if (table === 'team_members') return respond(f.membership ?? null);
      if (table === 'teams') return respond(f.team ?? null);
      if (table === 'team_signing_keys') return respond({ key_hex: SIGNING_KEY, version: 1 });
      if (table === 'evidence_bundles') {
        return { insert: (row: Record<string, unknown>) => { tables.evidence_bundles.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === 'audit_events') {
        const rows = f.events ?? [];
        // seqRangeForPeriod: two ordered single-row lookups; fetchChainSegment: the range.
        const q: Record<string, unknown> = {};
        let sel = [...rows];
        let desc = false;
        let lim: number | undefined;
        for (const m of ['select', 'eq']) q[m] = () => q;
        q.gte = (col: string, v: unknown) => { sel = sel.filter((r) => (col === 'seq' ? r.seq >= Number(v) : r.created_at >= String(v))); return q; };
        q.lte = (col: string, v: unknown) => { sel = sel.filter((r) => (col === 'seq' ? r.seq <= Number(v) : r.created_at <= String(v))); return q; };
        q.order = (_c: string, o?: { ascending?: boolean }) => { desc = o?.ascending === false; return q; };
        q.limit = (n: number) => { lim = n; return q; };
        const result = () => { const out = desc ? [...sel].reverse() : sel; return lim === undefined ? out : out.slice(0, lim); };
        q.maybeSingle = () => Promise.resolve({ data: result()[0] ?? null, error: null });
        (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: result(), error: null }).then(res);
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'audit_append') { chainEvents.push(args); return Promise.resolve({ data: 100, error: null }); }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { db: db as unknown as SupabaseClient, tables, chainEvents, looked };
}

async function chain(n: number): Promise<AuditEventRow[]> {
  const rows: AuditEventRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const base = {
      team_id: BUSINESS.id, seq, event_type: 'validation_run' as const, actor: 'user_x', actor_role: 'member', subject: `v${seq}`,
      payload: { n: seq }, payload_canonical: `{"n": ${seq}}`, prev_hash: prev,
      created_at: `2026-09-${String(seq).padStart(2, '0')}T10:00:00.000Z`, created_at_iso: `2026-09-${String(seq).padStart(2, '0')}T10:00:00.000000Z`,
    };
    const hash = await hashAuditEvent(base);
    rows.push({ ...base, hash });
    prev = hash;
  }
  return rows;
}

const withKey = (key = API_KEY) => new Request('https://safesqlpro.dev/api/teams/evidence/bundle', { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
const withJwt = () => new Request('https://safesqlpro.dev/api/teams/evidence/bundle', { method: 'POST', headers: { Authorization: 'Bearer eyJ.clerk.session' } });
const neverJwt = async () => null;

describe('requireEvidenceAccess — API key path', () => {
  it('valid ssk_live_ key of a Business team owner → access object, and the real key hash was looked up', async () => {
    const f = makeDb({ keyRow: { user_id: 'u1', revoked_at: null, users: { plan: 'business', clerk_user_id: OWNER } }, membership: { team_id: BUSINESS.id, role: 'owner' }, team: BUSINESS });
    const a = await requireEvidenceAccess(withKey(), ENV, { db: f.db, verifyJwt: neverJwt });
    expect(a).not.toBeInstanceOf(Response);
    const access = a as EvidenceAccess;
    expect(access.team).toEqual(BUSINESS);
    expect(access.role).toBe('owner');
    expect(access.clerkUserId).toBe(OWNER);
    expect(f.looked).toEqual(['api_keys', 'team_members', 'teams']);
    // the lookup is by sha-256 of the key, never the raw key
    expect(await hashApiKey(API_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ssk_ key whose team is not Business → 402 with the upgrade pointer', async () => {
    const f = makeDb({ keyRow: { user_id: 'u1', revoked_at: null, users: { plan: 'team', clerk_user_id: OWNER } }, membership: { team_id: BUSINESS.id, role: 'owner' }, team: TEAM_PLAN });
    const r = (await requireEvidenceAccess(withKey(), ENV, { db: f.db, verifyJwt: neverJwt })) as Response;
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: 'Evidence chain access is a Business feature', plan: 'team', upgrade: '#/pricing' } as Record<string, unknown>);
  });

  it('ssk_ key with no team membership → 401 with the exact message', async () => {
    const f = makeDb({ keyRow: { user_id: 'u1', revoked_at: null, users: { plan: 'business', clerk_user_id: OWNER } }, membership: null });
    const r = (await requireEvidenceAccess(withKey(), ENV, { db: f.db, verifyJwt: neverJwt })) as Response;
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe(API_KEY_NO_TEAM_ERROR);
    expect(API_KEY_NO_TEAM_ERROR).toBe('API key owner is not a member of any team');
  });

  it('unknown or revoked ssk_ key → 401, and the JWT verifier is never consulted', async () => {
    let jwtCalls = 0;
    const countJwt = async () => { jwtCalls++; return null; };
    const unknown = makeDb({ keyRow: null });
    expect(((await requireEvidenceAccess(withKey(), ENV, { db: unknown.db, verifyJwt: countJwt })) as Response).status).toBe(401);
    const revoked = makeDb({ keyRow: { user_id: 'u1', revoked_at: '2026-09-01T00:00:00Z', users: { plan: 'business', clerk_user_id: OWNER } }, membership: { team_id: BUSINESS.id, role: 'owner' }, team: BUSINESS });
    expect(((await requireEvidenceAccess(withKey(), ENV, { db: revoked.db, verifyJwt: countJwt })) as Response).status).toBe(401);
    expect(jwtCalls).toBe(0);
    expect(unknown.looked).toEqual(['api_keys']);
  });

  it('Clerk JWT path is unchanged: verifier result → membership → plan; no api_keys lookup; no-team stays 404', async () => {
    const f = makeDb({ membership: { team_id: BUSINESS.id, role: 'auditor' }, team: BUSINESS });
    const a = (await requireEvidenceAccess(withJwt(), ENV, { db: f.db, verifyJwt: async () => 'user_aud' })) as EvidenceAccess;
    expect(a.clerkUserId).toBe('user_aud');
    expect(a.role).toBe('auditor');
    expect(f.looked).toEqual(['team_members', 'teams']);
    const anon = makeDb({});
    expect(((await requireEvidenceAccess(withJwt(), ENV, { db: anon.db, verifyJwt: neverJwt })) as Response).status).toBe(401);
    const noTeam = makeDb({ membership: null });
    const r = (await requireEvidenceAccess(withJwt(), ENV, { db: noTeam.db, verifyJwt: async () => 'user_solo' })) as Response;
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('You are not a member of a team');
  });

  it('end to end: POST /api/teams/evidence/bundle with a Business owner key → 201 signed bundle', async () => {
    const events = await chain(6);
    const f = makeDb({ keyRow: { user_id: 'u1', revoked_at: null, users: { plan: 'business', clerk_user_id: OWNER } }, membership: { team_id: BUSINESS.id, role: 'owner' }, team: BUSINESS, events });
    const body = JSON.stringify({ period_from: '2026-09-01T00:00:00Z', period_to: '2026-09-30T00:00:00Z' });
    const req = new Request('https://safesqlpro.dev/api/teams/evidence/bundle', { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body });
    const r = await handleBundleCreate(req, {
      access: (rq) => requireEvidenceAccess(rq, ENV, { db: f.db, verifyJwt: neverJwt }),
      now: () => NOW,
      newId: () => '9f1c2d3e-0000-4000-8000-000000000001',
      siteUrl: 'https://safesqlpro.dev',
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { bundle: Record<string, unknown>; download_url: string };
    expect(j.bundle).toMatchObject({ team_id: BUSINESS.id, chain_from_seq: 1, chain_to_seq: 6, event_count: 6, generated_by: OWNER, generated_by_role: 'owner' });
    expect(String(j.bundle.bundle_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(j.download_url).toBe('https://safesqlpro.dev/api/teams/evidence/bundle/9f1c2d3e-0000-4000-8000-000000000001/download');
    expect(f.tables.evidence_bundles).toHaveLength(1);
    expect(f.chainEvents[0]).toMatchObject({ p_event_type: 'evidence_bundle_generated', p_actor: OWNER, p_actor_role: 'owner' });
  });
});
