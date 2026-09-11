import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BUNDLE_FORMAT_VERSION,
  buildBundleZip,
  buildEventsJsonl,
  buildManifest,
  buildZip,
  bundleFilename,
  bundleHashInput,
  computeBundleHash,
  crc32,
  hmacSha256Hex,
  keyFingerprint,
  readZip,
  signBundle,
  signatureInput,
  stableStringify,
} from '../src/services/evidenceBundle';
import { GENESIS_HASH, hashAuditEvent, verifyChain, type AuditEventRow } from '../src/services/auditChain';

// Sprint 9 item 5 — the pure bundle module, including running the shipped
// verify.mjs with real Node against a real generated bundle. Lives in cli/
// (Node modules; outside tsconfig.app.json).

async function chain(n: number, teamId = 'team-1'): Promise<AuditEventRow[]> {
  const rows: AuditEventRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const payload = { n: seq, kind: seq % 2 ? 'a' : 'b' };
    const base = {
      team_id: teamId, seq, event_type: (seq % 4 === 0 ? 'approval_approved' : 'validation_run') as AuditEventRow['event_type'],
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
const KEY = 'ab'.repeat(32);

describe('zip writer', () => {
  it('produces a valid STORED archive that round-trips with correct CRCs', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }], new Date('2026-09-11T12:34:56Z'));
    // PK\x03\x04 local header, PK\x05\x06 end record
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...zip.subarray(zip.length - 22, zip.length - 18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin']);
    expect(new TextDecoder().decode(entries[0].data)).toBe('hello');
    expect([...entries[1].data]).toEqual([0, 1, 2, 255]);
    expect(entries.every((e) => e.crcOk)).toBe(true);
  });
  it('is byte-deterministic and crc32 matches the reference implementation', () => {
    const a = buildZip([{ name: 'x', data: 'same' }], new Date('2026-01-01T00:00:00Z'));
    const b = buildZip([{ name: 'x', data: 'same' }], new Date('2026-01-01T00:00:00Z'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('hashes and signature', () => {
  it('stableStringify sorts keys recursively and leaves payload_canonical untouched', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('bundle_hash follows the published recipe and is content-only', async () => {
    const rows = await chain(5);
    const jsonl = buildEventsJsonl(rows);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.split('\n').filter(Boolean)).toHaveLength(5);
    const range = { teamId: 'team-1', fromSeq: 1, toSeq: 5, headHash: rows[4].hash };
    const h = await computeBundleHash(jsonl, range);
    expect(h).toBe(createHash('sha256').update(bundleHashInput(jsonl, range), 'utf8').digest('hex'));
    // regenerating from the same rows → same hash; a different segment → different hash
    expect(await computeBundleHash(buildEventsJsonl(rows), range)).toBe(h);
    expect(await computeBundleHash(buildEventsJsonl(rows.slice(0, 4)), { ...range, toSeq: 4, headHash: rows[3].hash })).not.toBe(h);
  });
  it('signature is HMAC-SHA256 over bundle_hash‖id‖created_at with the team key; fingerprint is sha256(key)', async () => {
    const sig = await signBundle(KEY, 'cd'.repeat(32), 'bundle-1', '2026-09-11T12:00:00.000Z');
    expect(sig).toBe(createHmac('sha256', Buffer.from(KEY, 'hex')).update(signatureInput('cd'.repeat(32), 'bundle-1', '2026-09-11T12:00:00.000Z'), 'utf8').digest('hex'));
    expect(await signBundle(KEY, 'cd'.repeat(32), 'bundle-2', '2026-09-11T12:00:00.000Z')).not.toBe(sig); // bound to the row
    expect(await hmacSha256Hex('ef'.repeat(32), 'x')).not.toBe(await hmacSha256Hex(KEY, 'x'));
    expect(await keyFingerprint(KEY)).toBe(createHash('sha256').update(KEY, 'utf8').digest('hex'));
    await expect(hmacSha256Hex('not-hex', 'x')).rejects.toThrow(/hex/);
  });
});

describe('manifest + bundle zip + verify.mjs', () => {
  async function makeBundle(n = 8) {
    const rows = await chain(n);
    const jsonl = buildEventsJsonl(rows);
    const range = { teamId: 'team-1', fromSeq: 1, toSeq: n, headHash: rows[n - 1].hash };
    const bundleHash = await computeBundleHash(jsonl, range);
    const createdAt = '2026-09-11T12:00:00.000Z';
    const bundleId = '9f1c2d3e-0000-4000-8000-000000000001';
    const signature = await signBundle(KEY, bundleHash, bundleId, createdAt);
    const manifest = buildManifest({
      bundleId, team: { id: 'team-1', name: 'Acme', slug: 'acme' }, period: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' },
      rows, eventsJsonl: jsonl, eventsSha256: createHash('sha256').update(jsonl, 'utf8').digest('hex'), bundleHash, signature,
      signingKey: { version: 1, fingerprint: await keyFingerprint(KEY) }, generatedBy: { clerk_user_id: 'user_aud', role: 'auditor', email: 'a@x.io' },
      createdAt, detectorVersion: '0.10.0', appVersion: '0.10.0', verifyOnlineUrl: `https://safesqlpro.dev/api/teams/evidence/bundle/${bundleId}/verify`,
    });
    return { rows, jsonl, manifest, zip: buildBundleZip(manifest, jsonl) };
  }

  it('manifest carries counts, range, files digest, key fingerprint — and never key material or SQL', async () => {
    const { manifest, jsonl } = await makeBundle(8);
    expect(manifest).toMatchObject({
      format_version: BUNDLE_FORMAT_VERSION, chain: { from_seq: 1, to_seq: 8, event_count: 8 },
      validation_count: 6, approval_count: 2, signing_key: { version: 1 }, generated_by: { role: 'auditor' },
    });
    expect(manifest.files['events.jsonl'].bytes).toBe(Buffer.byteLength(jsonl));
    expect(JSON.stringify(manifest)).not.toContain(KEY);
    expect(bundleFilename('acme', '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z', manifest.bundle_id)).toBe('safesql-evidence-acme-2026-09-01-2026-09-30-9f1c2d3e.zip');
  });

  it('the zip contains the five files and is deterministic', async () => {
    const a = await makeBundle(6);
    const b = await makeBundle(6);
    expect(readZip(a.zip).map((e) => e.name)).toEqual(['README.md', 'manifest.json', 'events.jsonl', 'verify.mjs', 'signature.txt']);
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
    const sig = new TextDecoder().decode(readZip(a.zip)[4].data).split('\n');
    expect(sig[0]).toBe(a.manifest.signature);
    expect(sig[3]).toBe(a.manifest.bundle_hash);
  });

  it('verify.mjs PASSES on an intact bundle and FAILS when a single event is edited', async () => {
    const { zip } = await makeBundle(10);
    const dir = mkdtempSync(join(tmpdir(), 'safesql-bundle-'));
    for (const e of readZip(zip)) writeFileSync(join(dir, e.name), e.data);
    const ok = spawnSync(process.execPath, [join(dir, 'verify.mjs'), dir], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain('ALL CHECKS PASSED');
    expect(ok.stdout).toContain('Verify the signature online');
    // tamper: change one actor in events.jsonl
    const tampered = readZip(zip).find((e) => e.name === 'events.jsonl')!;
    const lines = new TextDecoder().decode(tampered.data).split('\n');
    lines[3] = lines[3].replace('"user_x"', '"someone_else"');
    writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'));
    const bad = spawnSync(process.execPath, [join(dir, 'verify.mjs'), dir], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/FAIL event hashes/);
    expect(bad.stdout).toMatch(/FAIL events\.jsonl sha256/);
    expect(bad.stdout).toMatch(/FAIL bundle_hash/);
  });

  it('a bundle only signs a chain the TS verifier accepts', async () => {
    const rows = await chain(4);
    rows[2].prev_hash = 'f'.repeat(64);
    expect((await verifyChain(rows)).ok).toBe(false);
  });
});
