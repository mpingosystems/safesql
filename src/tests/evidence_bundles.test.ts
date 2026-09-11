import { describe, expect, it } from 'vitest';
import { handleBundleCreate } from '../../functions/api/teams/evidence/bundle';
import { handleBundlesList } from '../../functions/api/teams/evidence/bundles';
import { handleBundleDownload } from '../../functions/api/teams/evidence/bundle/[id]/download';
import { handleBundleVerify } from '../../functions/api/teams/evidence/bundle/[id]/verify';
import { bundleIdFromPath } from '../../functions/api/teams/evidence/bundle/[id]/_shared';
import type { EvidenceAccess } from '../../functions/api/teams/evidence/_shared';
import { GENESIS_HASH, hashAuditEvent, type AuditEventRow } from '../services/auditChain';
import { computeBundleHash, buildEventsJsonl, keyFingerprint, readZip, signBundle } from '../services/evidenceBundle';

// Sprint 9 item 5 — evidence bundle routes, mocked Supabase.

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: 'user_owner' };
const KEY = 'ab'.repeat(32);
const BUNDLE_ID = '9f1c2d3e-0000-4000-8000-000000000001';

async function chain(n: number): Promise<AuditEventRow[]> {
  const rows: AuditEventRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const day = String(seq).padStart(2, '0');
    const base = {
      team_id: TEAM.id, seq, event_type: (seq % 3 === 0 ? 'approval_approved' : 'validation_run') as AuditEventRow['event_type'],
      actor: 'user_x', actor_role: 'member', subject: `v${seq}`, payload: { n: seq }, payload_canonical: `{"n": ${seq}}`, prev_hash: prev,
      created_at: `2026-09-${day}T10:00:00.000Z`, created_at_iso: `2026-09-${day}T10:00:00.000000Z`,
    };
    const hash = await hashAuditEvent(base);
    rows.push({ ...base, hash });
    prev = hash;
  }
  return rows;
}

function makeDb(events: AuditEventRow[], bundles: Record<string, unknown>[] = []) {
  const tables: Record<string, Record<string, unknown>[]> = {
    audit_events: events as unknown as Record<string, unknown>[],
    evidence_bundles: bundles,
    team_signing_keys: [{ team_id: TEAM.id, version: 1, key_hex: KEY, active: true }],
    team_members: [{ team_id: TEAM.id, clerk_user_id: 'user_aud', email: 'a@x.io' }, { team_id: TEAM.id, clerk_user_id: 'user_owner', email: 'o@x.io' }],
  };
  const chainEvents: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const src = tables[table] ?? (tables[table] = []);
    let rows = [...src];
    let single = false; let ins: Record<string, unknown> | null = null; let desc = false; let lim: number | undefined; let orderCol = 'seq';
    const q: Record<string, unknown> = {};
    const f = (fn: (r: Record<string, unknown>) => boolean) => { rows = rows.filter(fn); return q; };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => f((r) => r[c] === v);
    q.in = (c: string, vs: unknown[]) => f((r) => vs.includes(r[c]));
    q.gte = (c: string, v: unknown) => f((r) => (r[c] as never) >= (v as never));
    q.lte = (c: string, v: unknown) => f((r) => (r[c] as never) <= (v as never));
    q.lt = (c: string, v: unknown) => f((r) => (r[c] as never) < (v as never));
    q.order = (c: string, o: { ascending: boolean }) => { orderCol = c; desc = !o.ascending; return q; };
    q.limit = (n: number) => { lim = n; return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.insert = (r: Record<string, unknown>) => { ins = r; return q; };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      if (ins) { src.push(ins); return Promise.resolve({ data: null, error: null }).then(res); }
      let out = [...rows].sort((a, b) => (a[orderCol]! < b[orderCol]! ? -1 : a[orderCol]! > b[orderCol]! ? 1 : 0) * (desc ? -1 : 1));
      if (lim !== undefined) out = out.slice(0, lim);
      return Promise.resolve({ data: single ? out[0] ?? null : out, error: null }).then(res);
    };
    return q;
  }
  return {
    from, tables, chainEvents,
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'verify_audit_chain') {
        const rows = (tables.audit_events as unknown as AuditEventRow[]).filter((r) => r.seq >= Number(args.p_from_seq) && r.seq <= Number(args.p_to_seq));
        const last = rows[rows.length - 1];
        return { data: [{ ok: true, checked: rows.length, first_seq: rows[0]?.seq ?? null, last_seq: last?.seq ?? null, head_hash: last?.hash ?? null, first_bad_seq: null, reason: null }], error: null };
      }
      chainEvents.push(args);
      return { data: events.length + chainEvents.length, error: null };
    },
  };
}
const access = (db: ReturnType<typeof makeDb>, role = 'auditor', who = 'user_aud') => async (): Promise<EvidenceAccess | Response> =>
  ({ db: db as never, team: TEAM, role: role as EvidenceAccess['role'], clerkUserId: who });
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://safesqlpro.dev${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const NOW = new Date('2026-09-11T12:00:00.000Z');

describe('POST /api/teams/evidence/bundle', () => {
  it('auditor generates a bundle: verified segment, content hash, signature bound to the row, immutable insert, chain event', async () => {
    const events = await chain(9);
    const db = makeDb(events);
    const r = await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', { period_from: '2026-09-02T00:00:00Z', period_to: '2026-09-07T23:59:59Z' }), { access: access(db), now: () => NOW, newId: () => BUNDLE_ID, siteUrl: 'https://safesqlpro.dev' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.bundle).toMatchObject({ id: BUNDLE_ID, chain_from_seq: 2, chain_to_seq: 7, event_count: 6, validation_count: 4, approval_count: 2, signing_key_version: 1, generated_by: 'user_aud', generated_by_role: 'auditor', generated_by_email: 'a@x.io', created_at: NOW.toISOString() });
    // hash + signature follow the recipes exactly
    const seg = events.slice(1, 7);
    const expectedHash = await computeBundleHash(buildEventsJsonl(seg), { teamId: TEAM.id, fromSeq: 2, toSeq: 7, headHash: seg[5].hash });
    expect(j.bundle.bundle_hash).toBe(expectedHash);
    expect(j.bundle.signature).toBe(await signBundle(KEY, expectedHash, BUNDLE_ID, NOW.toISOString()));
    expect(j.chain).toMatchObject({ ok: true, checked: 6, firstSeq: 2, lastSeq: 7 });
    expect(j.download_url).toBe(`https://safesqlpro.dev/api/teams/evidence/bundle/${BUNDLE_ID}/download`);
    // stored row + chain event
    expect(db.tables.evidence_bundles[0]).toMatchObject({ id: BUNDLE_ID, bundle_hash: expectedHash, signing_key_version: 1, format_version: 1 });
    expect(db.chainEvents[0]).toMatchObject({ p_event_type: 'evidence_bundle_generated', p_actor: 'user_aud', p_actor_role: 'auditor', p_subject: BUNDLE_ID });
    expect((db.chainEvents[0].p_payload as Record<string, unknown>).key_fingerprint).toBe(await keyFingerprint(KEY));
    expect(JSON.stringify(j)).not.toContain(KEY);
  });

  it('member 403; bad period 400; empty period 409; broken segment 409 (never signed)', async () => {
    const events = await chain(5);
    const good = { period_from: '2026-09-01T00:00:00Z', period_to: '2026-09-30T00:00:00Z' };
    expect((await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', good), { access: access(makeDb(events), 'member', 'user_m') })).status).toBe(403);
    expect((await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', { period_from: 'yesterday', period_to: 'today' }), { access: access(makeDb(events)) })).status).toBe(400);
    expect((await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', { period_from: '2026-09-30T00:00:00Z', period_to: '2026-09-01T00:00:00Z' }), { access: access(makeDb(events)) })).status).toBe(400);
    expect((await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', { period_from: '2020-01-01T00:00:00Z', period_to: '2025-01-01T00:00:00Z' }), { access: access(makeDb(events)) })).status).toBe(400); // > 366 days
    expect((await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', { period_from: '2027-01-01T00:00:00Z', period_to: '2027-01-31T00:00:00Z' }), { access: access(makeDb(events)) })).status).toBe(409);
    const broken = await chain(5);
    broken[2].actor = 'tampered';
    const db = makeDb(broken);
    const r = await handleBundleCreate(req('POST', '/api/teams/evidence/bundle', good), { access: access(db) });
    expect(r.status).toBe(409);
    expect((await r.json()).chain).toMatchObject({ ok: false, firstBadSeq: 3 });
    expect(db.tables.evidence_bundles).toHaveLength(0);
    expect(db.chainEvents).toHaveLength(0);
  });
});

async function seeded() {
  const events = await chain(9);
  const seg = events.slice(1, 7);
  const bundleHash = await computeBundleHash(buildEventsJsonl(seg), { teamId: TEAM.id, fromSeq: 2, toSeq: 7, headHash: seg[5].hash });
  const row = {
    id: BUNDLE_ID, team_id: TEAM.id, period_from: '2026-09-02T00:00:00.000Z', period_to: '2026-09-07T23:59:59.000Z', chain_from_seq: 2, chain_to_seq: 7,
    chain_head_hash: seg[5].hash, event_count: 6, validation_count: 4, approval_count: 2, bundle_hash: bundleHash,
    signature: await signBundle(KEY, bundleHash, BUNDLE_ID, NOW.toISOString()), signing_key_version: 1, generated_by: 'user_aud', generated_by_role: 'auditor', format_version: 1, created_at: NOW.toISOString(),
  };
  return { events, row, db: makeDb(events, [row]) };
}

describe('GET /api/teams/evidence/bundles', () => {
  it('lists manifests newest first with generator email, can_generate by role, and the key fingerprint — never the key', async () => {
    const { db } = await seeded();
    const j = await (await handleBundlesList(req('GET', '/api/teams/evidence/bundles'), { access: access(db, 'member', 'user_m') })).json();
    expect(j.can_generate).toBe(false);
    expect(j.rows[0]).toMatchObject({ id: BUNDLE_ID, generated_by_email: 'a@x.io' });
    expect(j.signing_key).toEqual({ version: 1, fingerprint: await keyFingerprint(KEY) });
    expect(JSON.stringify(j)).not.toContain(KEY);
    const a = await (await handleBundlesList(req('GET', '/api/teams/evidence/bundles?limit=abc'), { access: access(db) })).json();
    expect(a.error).toMatch(/limit/);
  });
});

describe('GET /api/teams/evidence/bundle/:id/download', () => {
  it('regenerates a byte-deterministic zip whose manifest matches the stored row', async () => {
    const { db, row } = await seeded();
    const r = await handleBundleDownload(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/download`), { access: access(db, 'member', 'user_m'), siteUrl: 'https://safesqlpro.dev', appVersion: '0.10.0' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="safesql-evidence-acme-2026-09-02-2026-09-07-9f1c2d3e.zip"`);
    expect(r.headers.get('x-safesql-signature-valid')).toBe('true');
    const zip = new Uint8Array(await r.arrayBuffer());
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['README.md', 'manifest.json', 'events.jsonl', 'verify.mjs', 'signature.txt']);
    const manifest = JSON.parse(new TextDecoder().decode(files[1].data));
    expect(manifest).toMatchObject({ bundle_id: BUNDLE_ID, bundle_hash: row.bundle_hash, signature: row.signature, chain: { from_seq: 2, to_seq: 7, event_count: 6 }, generated_by: { role: 'auditor', email: 'a@x.io' }, signing_key: { version: 1 } });
    expect(new TextDecoder().decode(files[2].data).split('\n').filter(Boolean)).toHaveLength(6);
    const again = new Uint8Array(await (await handleBundleDownload(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/download`), { access: access(db), siteUrl: 'https://safesqlpro.dev', appVersion: '0.10.0' })).arrayBuffer());
    expect(again.length).toBe(zip.length);
    expect(again.every((b, i) => b === zip[i])).toBe(true);
  });

  it('refuses (409) when the chain no longer reproduces the stored hash; 404 unknown; 400 bad id', async () => {
    const { db, events } = await seeded();
    (events[4] as { actor: string }).actor = 'altered-in-storage';
    const r = await handleBundleDownload(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/download`), { access: access(db) });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.stored.bundle_hash).not.toBe(j.recomputed.bundle_hash);
    expect(j.chain.ok).toBe(false);
    expect((await handleBundleDownload(req('GET', '/api/teams/evidence/bundle/9f1c2d3e-0000-4000-8000-00000000ffff/download'), { access: access(db) })).status).toBe(404);
    expect((await handleBundleDownload(req('GET', '/api/teams/evidence/bundle/nope/download'), { access: access(db) })).status).toBe(400);
    expect(bundleIdFromPath(`/api/teams/evidence/bundle/${BUNDLE_ID}/verify`)).toBe(BUNDLE_ID);
  });
});

describe('GET /api/teams/evidence/bundle/:id/verify', () => {
  it('ok=true with matching hash, valid signature and agreeing db/local chain checks', async () => {
    const { db } = await seeded();
    const j = await (await handleBundleVerify(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/verify`), { access: access(db, 'member', 'user_m') })).json();
    expect(j).toMatchObject({ ok: true, bundle_hash: { matches: true }, signature: { valid: true, key_version: 1, key_active: true }, chain: { agree: true }, event_count: { stored: 6, recomputed: 6 } });
    expect(j.chain.db).toMatchObject({ ok: true, checked: 6 });
    expect(j.chain.local).toMatchObject({ ok: true, checked: 6 });
    expect(JSON.stringify(j)).not.toContain(KEY);
  });

  it('a tampered signature → valid:false, ok:false (still HTTP 200); a rotated key still verifies old bundles by version', async () => {
    const { db } = await seeded();
    (db.tables.evidence_bundles[0] as { signature: string }).signature = 'ff'.repeat(32);
    const j = await (await handleBundleVerify(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/verify`), { access: access(db) })).json();
    expect(j.ok).toBe(false);
    expect(j.signature.valid).toBe(false);
    expect(j.bundle_hash.matches).toBe(true);
    const s2 = await seeded();
    s2.db.tables.team_signing_keys[0].active = false;
    s2.db.tables.team_signing_keys.push({ team_id: TEAM.id, version: 2, key_hex: 'cd'.repeat(32), active: true });
    const v = await (await handleBundleVerify(req('GET', `/api/teams/evidence/bundle/${BUNDLE_ID}/verify`), { access: access(s2.db) })).json();
    expect(v.signature).toMatchObject({ valid: true, key_version: 1, key_active: false });
  });
});
