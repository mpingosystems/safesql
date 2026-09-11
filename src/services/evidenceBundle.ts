// Sprint 9 (compliance tier) — evidence bundles, the pure part.
//
// A bundle is a deterministic snapshot of a contiguous segment of a team's
// audit chain for a reporting period, signed with the team's HMAC key:
//
//   events.jsonl   the chain rows, exact stored columns, one per line, seq order
//   bundle_hash    sha256( events.jsonl ‖ '\n' ‖ team_id ‖ '\n' ‖ from_seq ‖ '\n' ‖ to_seq ‖ '\n' ‖ head_hash )
//                  — content only, so regenerating the same segment yields the same hash, forever
//   signature      HMAC-SHA256( team key , bundle_hash ‖ '\n' ‖ bundle_id ‖ '\n' ‖ created_at )
//                  — bound to the specific bundle row (who / when), not just its content
//
// Everything here is I/O-free and runs in Workers, Node and the browser (Web
// Crypto). The ZIP writer emits STORED entries with fixed timestamps so the
// archive bytes are a function of the content alone. No dependencies.

import type { AuditEventRow, AuditEventType, ChainVerification } from './auditChain';
import { AUDIT_EVENT_TYPES, auditRecordOf } from './auditChain';

export const BUNDLE_FORMAT_VERSION = 1;
export const MAX_BUNDLE_EVENTS = 50_000;

// ── Hashing helpers (Web Crypto) ─────────────────────────────────────────────

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256HexOf(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function hexToBytes(h: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(h) || h.length % 2 !== 0) throw new Error('key must be hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hmacSha256Hex(keyHex: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Public identifier of a signing key: sha256 of its hex form. Safe to publish. */
export function keyFingerprint(keyHex: string): Promise<string> {
  return sha256HexOf(keyHex);
}

// ── Canonical JSON (sorted keys) for events.jsonl ────────────────────────────
// payload_canonical is left exactly as stored; only the ROW envelope is
// re-serialised, and with sorted keys so the file is byte-stable.

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export function buildEventsJsonl(rows: readonly AuditEventRow[]): string {
  return rows.map((r) => stableStringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

// ── bundle_hash / signature recipes ──────────────────────────────────────────

export interface BundleRange {
  teamId: string;
  fromSeq: number;
  toSeq: number;
  headHash: string;
}

export const HASH_RECIPE =
  "bundle_hash = sha256(events.jsonl bytes + '\\n' + team_id + '\\n' + chain_from_seq + '\\n' + chain_to_seq + '\\n' + chain_head_hash); " +
  "signature = HMAC-SHA256(team signing key, bundle_hash + '\\n' + bundle_id + '\\n' + created_at); " +
  "event hash = sha256(prev_hash + '\\n' + seq + '\\n' + team_id + '\\n' + event_type + '\\n' + actor + '\\n' + (subject or '') + '\\n' + created_at_iso + '\\n' + payload_canonical)";

export function bundleHashInput(eventsJsonl: string, range: BundleRange): string {
  return `${eventsJsonl}\n${range.teamId}\n${range.fromSeq}\n${range.toSeq}\n${range.headHash}`;
}

export async function computeBundleHash(eventsJsonl: string, range: BundleRange): Promise<string> {
  return sha256HexOf(bundleHashInput(eventsJsonl, range));
}

export function signatureInput(bundleHash: string, bundleId: string, createdAtIso: string): string {
  return `${bundleHash}\n${bundleId}\n${createdAtIso}`;
}

export async function signBundle(keyHex: string, bundleHash: string, bundleId: string, createdAtIso: string): Promise<string> {
  return hmacSha256Hex(keyHex, signatureInput(bundleHash, bundleId, createdAtIso));
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface BundleManifest {
  format_version: number;
  bundle_id: string;
  team: { id: string; name: string; slug: string };
  period: { from: string; to: string };
  chain: { from_seq: number; to_seq: number; head_hash: string; event_count: number };
  counts_by_type: Record<AuditEventType, number>;
  validation_count: number;
  approval_count: number;
  generated_by: { clerk_user_id: string; role: string; email: string | null };
  created_at: string;
  detector_version: string;
  app_version: string;
  signing_key: { version: number; fingerprint: string };
  files: Record<string, { sha256: string; bytes: number }>;
  bundle_hash: string;
  signature: string;
  hash_recipe: string;
  verify_online: string;
}

export function countsByTypeOf(rows: readonly AuditEventRow[]): Record<AuditEventType, number> {
  const counts = Object.fromEntries(AUDIT_EVENT_TYPES.map((t) => [t, 0])) as Record<AuditEventType, number>;
  for (const r of rows) if (r.event_type in counts) counts[r.event_type] += 1;
  return counts;
}

export interface BuildManifestInput {
  bundleId: string;
  team: { id: string; name: string; slug: string };
  period: { from: string; to: string };
  rows: readonly AuditEventRow[];
  eventsJsonl: string;
  eventsSha256: string;
  bundleHash: string;
  signature: string;
  signingKey: { version: number; fingerprint: string };
  generatedBy: { clerk_user_id: string; role: string; email: string | null };
  createdAt: string;
  detectorVersion: string;
  appVersion: string;
  verifyOnlineUrl: string;
}

export function buildManifest(i: BuildManifestInput): BundleManifest {
  const counts = countsByTypeOf(i.rows);
  const first = i.rows[0];
  const last = i.rows[i.rows.length - 1];
  return {
    format_version: BUNDLE_FORMAT_VERSION,
    bundle_id: i.bundleId,
    team: i.team,
    period: i.period,
    chain: { from_seq: first?.seq ?? 0, to_seq: last?.seq ?? 0, head_hash: last?.hash ?? '', event_count: i.rows.length },
    counts_by_type: counts,
    validation_count: counts.validation_run,
    approval_count: counts.approval_requested + counts.approval_approved + counts.approval_rejected,
    generated_by: i.generatedBy,
    created_at: i.createdAt,
    detector_version: i.detectorVersion,
    app_version: i.appVersion,
    signing_key: i.signingKey,
    files: { 'events.jsonl': { sha256: i.eventsSha256, bytes: enc.encode(i.eventsJsonl).byteLength } },
    bundle_hash: i.bundleHash,
    signature: i.signature,
    hash_recipe: HASH_RECIPE,
    verify_online: i.verifyOnlineUrl,
  };
}

// ── Deterministic STORED ZIP writer ──────────────────────────────────────────
// PKZIP 2.0 layout: [local header + data]* , central directory, end record.
// Method 0 (stored), no data descriptors, no ZIP64 (bundles are ≤ a few MB),
// fixed DOS timestamp from `mtime` so identical input → identical bytes.

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  const date = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date, time };
}

export function buildZip(entries: readonly ZipEntry[], mtime: Date): Uint8Array {
  const { date, time } = dosDateTime(mtime);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Minimal reader for tests / verification: names, sizes, CRC-checked data of a STORED zip. */
export function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array; crcOk: boolean }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find EOCD (no comment, so it is the last 22 bytes).
  const eocd = bytes.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('not a zip (EOCD missing)');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const out: Array<{ name: string; data: Uint8Array; crcOk: boolean }> = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    out.push({ name, data, crcOk: crc32(data) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Files shipped inside the bundle ─────────────────────────────────────────

export const VERIFY_SCRIPT = `#!/usr/bin/env node
// SafeSQL Pro evidence bundle — offline verifier. Node 18+. No dependencies.
//   node verify.mjs            (run inside the unzipped bundle directory)
//   node verify.mjs <dir>
// Checks, using only sha256:
//   1. every event's hash equals sha256 of its stored 8-field record
//   2. every prev_hash equals the previous event's hash; seq has no gaps
//   3. events.jsonl sha256 equals manifest.files["events.jsonl"].sha256
//   4. bundle_hash equals sha256(events.jsonl + team_id + from_seq + to_seq + head_hash)
// It CANNOT check the HMAC signature — that needs the team's private signing
// key, which never leaves SafeSQL Pro. Verify it online: manifest.verify_online.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const jsonlBytes = readFileSync(join(dir, 'events.jsonl'));
const jsonl = jsonlBytes.toString('utf8');
const sha = (x) => createHash('sha256').update(x).digest('hex');
let failures = 0;
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')); if (!ok) failures++; };

const rows = jsonl.split('\\n').filter(Boolean).map((l) => JSON.parse(l));
check(rows.length === manifest.chain.event_count, 'event count', rows.length + ' events');

let prev = null, prevSeq = null, hashOk = 0, linkOk = 0;
for (const r of rows) {
  const record = [r.prev_hash, String(r.seq), r.team_id, r.event_type, r.actor, r.subject ?? '', r.created_at_iso, r.payload_canonical].join('\\n');
  if (sha(record) === r.hash) hashOk++; else console.log('  bad hash at seq ' + r.seq);
  if (prev === null) { if (r.seq === 1 && r.prev_hash !== '0'.repeat(64)) console.log('  bad genesis'); else linkOk++; }
  else if (r.seq === prevSeq + 1 && r.prev_hash === prev) linkOk++;
  else console.log('  broken link at seq ' + r.seq);
  prev = r.hash; prevSeq = r.seq;
}
check(hashOk === rows.length, 'event hashes', hashOk + '/' + rows.length);
check(linkOk === rows.length, 'chain linkage', linkOk + '/' + rows.length);
check(sha(jsonlBytes) === manifest.files['events.jsonl'].sha256, 'events.jsonl sha256');
const recipe = jsonl + '\\n' + manifest.team.id + '\\n' + manifest.chain.from_seq + '\\n' + manifest.chain.to_seq + '\\n' + manifest.chain.head_hash;
check(sha(recipe) === manifest.bundle_hash, 'bundle_hash', manifest.bundle_hash.slice(0, 16) + '…');
check(rows.length === 0 || rows[rows.length - 1].hash === manifest.chain.head_hash, 'head hash matches last event');
console.log('\\nSignature ' + manifest.signature.slice(0, 16) + '… by key v' + manifest.signing_key.version + ' (fingerprint ' + manifest.signing_key.fingerprint.slice(0, 16) + '…)');
console.log('Verify the signature online: ' + manifest.verify_online);
console.log(failures === 0 ? '\\nALL CHECKS PASSED' : '\\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
`;

export function buildReadme(m: BundleManifest): string {
  return `# SafeSQL Pro — Evidence Bundle

Team: ${m.team.name} (${m.team.slug})
Period: ${m.period.from} → ${m.period.to}
Chain segment: seq ${m.chain.from_seq}–${m.chain.to_seq} (${m.chain.event_count} events), head ${m.chain.head_hash}
Generated: ${m.created_at} by ${m.generated_by.email ?? m.generated_by.clerk_user_id} (${m.generated_by.role})
Bundle id: ${m.bundle_id}
Format: v${m.format_version} · SafeSQL Pro ${m.app_version} · detectors ${m.detector_version}

## What this is
A tamper-evident record of every validation, approval decision, policy/rule
change and membership change on this team's audit chain during the period.
Each event is SHA-256 hash-chained to the one before it; the segment is
summarised by bundle_hash and signed with the team's HMAC key.

Only a SHA-256 hash of validated SQL is recorded — never the query text.
Approval requests carry the SQL that was approved; that lives in SafeSQL Pro,
not in this bundle.

## Files
- manifest.json   what was bundled, by whom, hashes, signature, key fingerprint
- events.jsonl    the chain rows, exactly as stored (one JSON object per line)
- verify.mjs      offline verifier (Node 18+, no dependencies)
- signature.txt   signature · key version · key fingerprint · bundle_hash

## Verify offline
    node verify.mjs

Recomputes every event hash, the chain linkage, the events.jsonl digest and
bundle_hash from the files in this directory. Anything altered fails.

## Verify the signature
The HMAC signature needs the team's private key, which stays inside SafeSQL
Pro. Any seated member of the team can verify it:
    ${m.verify_online}
The key fingerprint (${m.signing_key.fingerprint}) identifies which key
version signed, without revealing it.

## Recipes
${m.hash_recipe}
`;
}

export function buildSignatureTxt(m: BundleManifest): string {
  return `${m.signature}\n${m.signing_key.version}\n${m.signing_key.fingerprint}\n${m.bundle_hash}\n`;
}

/** Assemble the archive. Deterministic for a given manifest + events. */
export function buildBundleZip(manifest: BundleManifest, eventsJsonl: string): Uint8Array {
  const entries: ZipEntry[] = [
    { name: 'README.md', data: buildReadme(manifest) },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'events.jsonl', data: eventsJsonl },
    { name: 'verify.mjs', data: VERIFY_SCRIPT },
    { name: 'signature.txt', data: buildSignatureTxt(manifest) },
  ];
  return buildZip(entries, new Date(manifest.created_at));
}

export function bundleFilename(slug: string, from: string, to: string, bundleId: string): string {
  const d = (s: string) => s.slice(0, 10);
  return `safesql-evidence-${slug}-${d(from)}-${d(to)}-${bundleId.slice(0, 8)}.zip`;
}

/** Re-export for callers that build events from rows and want the same record text as SQL/TS. */
export { auditRecordOf };
export type { ChainVerification };
