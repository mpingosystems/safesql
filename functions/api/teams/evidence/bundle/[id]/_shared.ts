import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchChainSegment, memberEmail, signingKeyFor, type EvidenceAccess } from '../../_shared';
import { verifyChain, type AuditEventRow, type ChainVerification } from '../../../../../../src/services/auditChain';
import { buildEventsJsonl, computeBundleHash, keyFingerprint, sha256HexOf, signBundle } from '../../../../../../src/services/evidenceBundle';

// Sprint 9 (compliance tier) — shared regeneration for download + verify.
// A bundle row is a manifest; the content comes from the immutable chain. So
// every download is also an integrity check: regenerate, recompute, compare.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bundleIdFromPath(pathname: string): string | null {
  const m = /\/api\/teams\/evidence\/bundle\/([^/]+)\/(download|verify)\/?$/.exec(pathname);
  return m && UUID_RE.test(m[1]) ? m[1] : null;
}

export interface BundleRow {
  id: string;
  team_id: string;
  period_from: string;
  period_to: string;
  chain_from_seq: number;
  chain_to_seq: number;
  chain_head_hash: string;
  event_count: number;
  validation_count: number;
  approval_count: number;
  bundle_hash: string;
  signature: string;
  signing_key_version: number;
  generated_by: string;
  generated_by_role: string;
  format_version: number;
  created_at: string;
}

export async function loadBundle(db: SupabaseClient, teamId: string, id: string): Promise<BundleRow | null> {
  const { data } = await db.from('evidence_bundles').select('*').eq('id', id).eq('team_id', teamId).maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    ...(r as unknown as BundleRow),
    chain_from_seq: Number(r.chain_from_seq),
    chain_to_seq: Number(r.chain_to_seq),
    event_count: Number(r.event_count),
    validation_count: Number(r.validation_count),
    approval_count: Number(r.approval_count),
    signing_key_version: Number(r.signing_key_version),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    period_from: r.period_from instanceof Date ? r.period_from.toISOString() : String(r.period_from),
    period_to: r.period_to instanceof Date ? r.period_to.toISOString() : String(r.period_to),
  };
}

export interface Regenerated {
  rows: AuditEventRow[];
  eventsJsonl: string;
  eventsSha256: string;
  chain: ChainVerification;
  recomputedHash: string;
  hashMatches: boolean;
  signature: { valid: boolean | null; key_version: number; key_fingerprint: string | null; key_active: boolean | null };
  generatedByEmail: string | null;
}

/** Rebuild the segment from the chain and recompute everything the row claims. */
export async function regenerate(access: EvidenceAccess, bundle: BundleRow): Promise<Regenerated> {
  const { db, team } = access;
  const rows = await fetchChainSegment(db, team.id, bundle.chain_from_seq, bundle.chain_to_seq);
  const chain = await verifyChain(rows);
  const eventsJsonl = buildEventsJsonl(rows);
  const head = rows[rows.length - 1];
  const recomputedHash = await computeBundleHash(eventsJsonl, {
    teamId: team.id,
    fromSeq: bundle.chain_from_seq,
    toSeq: bundle.chain_to_seq,
    headHash: head?.hash ?? bundle.chain_head_hash,
  });
  const hashMatches = recomputedHash === bundle.bundle_hash && (head?.hash ?? '') === bundle.chain_head_hash;

  const key = await signingKeyFor(db, team.id, bundle.signing_key_version);
  let valid: boolean | null = null;
  let fingerprint: string | null = null;
  if (key) {
    fingerprint = await keyFingerprint(key.key_hex);
    valid = (await signBundle(key.key_hex, bundle.bundle_hash, bundle.id, bundle.created_at)) === bundle.signature;
  }

  return {
    rows,
    eventsJsonl,
    eventsSha256: await sha256HexOf(eventsJsonl),
    chain,
    recomputedHash,
    hashMatches,
    signature: { valid, key_version: bundle.signing_key_version, key_fingerprint: fingerprint, key_active: key ? key.active : null },
    generatedByEmail: await memberEmail(db, team.id, bundle.generated_by),
  };
}
