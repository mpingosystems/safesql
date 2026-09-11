import type { Env } from '../../../../../_shared';
import { jsonRes, preflight } from '../../../_shared';
import { requireEvidenceAccess, type EvidenceAccess } from '../../_shared';
import { bundleIdFromPath, loadBundle, regenerate } from './_shared';

// Sprint 9 (compliance tier) — GET /api/teams/evidence/bundle/:id/verify
//
// The online half of bundle verification: recomputes bundle_hash from the
// chain, re-derives the HMAC with the recorded key version, and re-verifies
// the segment in Postgres AND in this Worker. HTTP 200 even when something
// fails — a negative result is a successful verification.

export interface BundleVerifyDeps {
  access(request: Request): Promise<EvidenceAccess | Response>;
}

function fromDb(row: Record<string, unknown> | undefined) {
  if (!row) return { ok: false, checked: 0, reason: 'verify_audit_chain returned no row' };
  return {
    ok: row.ok === true,
    checked: Number(row.checked ?? 0),
    ...(row.head_hash ? { headHash: String(row.head_hash) } : {}),
    ...(row.first_bad_seq !== null && row.first_bad_seq !== undefined ? { firstBadSeq: Number(row.first_bad_seq) } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
  };
}

export async function handleBundleVerify(request: Request, deps: BundleVerifyDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const id = bundleIdFromPath(new URL(request.url).pathname);
  if (!id) return jsonRes({ error: 'bundle id must be a UUID' }, 400);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team } = access;

  const bundle = await loadBundle(db, team.id, id);
  if (!bundle) return jsonRes({ error: 'Bundle not found' }, 404);

  let gen;
  try {
    gen = await regenerate(access, bundle);
  } catch (e) {
    return jsonRes({ error: (e as Error).message }, 500);
  }

  const { data: dbRows, error: dbErr } = await db.rpc('verify_audit_chain', {
    p_team_id: team.id,
    p_from_seq: bundle.chain_from_seq,
    p_to_seq: bundle.chain_to_seq,
  });
  const dbVerification = dbErr
    ? { ok: false, checked: 0, reason: `verify_audit_chain failed: ${dbErr.message}` }
    : fromDb(Array.isArray(dbRows) ? (dbRows[0] as Record<string, unknown> | undefined) : (dbRows as Record<string, unknown> | undefined));
  const agree =
    dbVerification.ok === gen.chain.ok &&
    dbVerification.checked === gen.chain.checked &&
    ('headHash' in dbVerification ? dbVerification.headHash : null) === (gen.chain.headHash ?? null);

  const ok = gen.hashMatches && gen.signature.valid === true && gen.chain.ok && dbVerification.ok && agree;

  return jsonRes(
    {
      bundle_id: bundle.id,
      ok,
      bundle_hash: { stored: bundle.bundle_hash, recomputed: gen.recomputedHash, matches: gen.hashMatches },
      chain_head: { stored: bundle.chain_head_hash, recomputed: gen.rows[gen.rows.length - 1]?.hash ?? null },
      event_count: { stored: bundle.event_count, recomputed: gen.rows.length },
      events_sha256: gen.eventsSha256,
      signature: gen.signature,
      chain: { db: dbVerification, local: gen.chain, agree },
      generated_by: { clerk_user_id: bundle.generated_by, role: bundle.generated_by_role, email: gen.generatedByEmail },
      created_at: bundle.created_at,
      checked_at: new Date().toISOString(),
    },
    200,
  );
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleBundleVerify(context.request, { access: (req) => requireEvidenceAccess(req, context.env) });
