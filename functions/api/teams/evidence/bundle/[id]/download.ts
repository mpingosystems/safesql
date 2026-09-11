import type { Env } from '../../../../../_shared';
import { corsHeaders, jsonRes, preflight, siteOrigin } from '../../../_shared';
import { requireEvidenceAccess, type EvidenceAccess } from '../../_shared';
import { bundleIdFromPath, loadBundle, regenerate } from './_shared';
import { buildBundleZip, buildManifest, bundleFilename } from '../../../../../../src/services/evidenceBundle';
import { DETECTOR_VERSION } from '../../../../../../src/config/detectorVersion';

// Sprint 9 (compliance tier) — GET /api/teams/evidence/bundle/:id/download
//
// Regenerates the archive from the immutable chain. If the recomputed
// bundle_hash no longer equals the stored one, the download is refused with
// 409 — the chain is append-only, so a mismatch can only mean the storage
// layer was altered, and that IS the finding.

export interface BundleDownloadDeps {
  access(request: Request): Promise<EvidenceAccess | Response>;
  siteUrl?: string;
  appVersion?: string;
}

export async function handleBundleDownload(request: Request, deps: BundleDownloadDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const id = bundleIdFromPath(new URL(request.url).pathname);
  if (!id) return jsonRes({ error: 'bundle id must be a UUID' }, 400);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { team, role } = access;

  const bundle = await loadBundle(access.db, team.id, id);
  if (!bundle) return jsonRes({ error: 'Bundle not found' }, 404);

  let gen;
  try {
    gen = await regenerate(access, bundle);
  } catch (e) {
    return jsonRes({ error: (e as Error).message }, 500);
  }
  if (!gen.hashMatches || !gen.chain.ok) {
    return jsonRes(
      {
        error: 'Chain content no longer matches this bundle — refusing to serve it',
        stored: { bundle_hash: bundle.bundle_hash, chain_head_hash: bundle.chain_head_hash, event_count: bundle.event_count },
        recomputed: { bundle_hash: gen.recomputedHash, chain_head_hash: gen.rows[gen.rows.length - 1]?.hash ?? null, event_count: gen.rows.length },
        chain: gen.chain,
      },
      409,
    );
  }

  const base = deps.siteUrl ?? '';
  const manifest = buildManifest({
    bundleId: bundle.id,
    team: { id: team.id, name: team.name, slug: team.slug },
    period: { from: bundle.period_from, to: bundle.period_to },
    rows: gen.rows,
    eventsJsonl: gen.eventsJsonl,
    eventsSha256: gen.eventsSha256,
    bundleHash: bundle.bundle_hash,
    signature: bundle.signature,
    signingKey: { version: bundle.signing_key_version, fingerprint: gen.signature.key_fingerprint ?? '' },
    generatedBy: { clerk_user_id: bundle.generated_by, role: bundle.generated_by_role, email: gen.generatedByEmail },
    createdAt: bundle.created_at,
    detectorVersion: DETECTOR_VERSION,
    appVersion: deps.appVersion ?? DETECTOR_VERSION,
    verifyOnlineUrl: `${base}/api/teams/evidence/bundle/${bundle.id}/verify`,
  });
  const zip = buildBundleZip(manifest, gen.eventsJsonl);
  const filename = bundleFilename(team.slug, bundle.period_from, bundle.period_to, bundle.id);

  return new Response(zip as BodyInit, {
    status: 200,
    headers: {
      ...corsHeaders,
      'content-type': 'application/zip',
      'content-length': String(zip.byteLength),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-safesql-bundle-hash': bundle.bundle_hash,
      'x-safesql-signature-valid': String(gen.signature.valid),
      'x-safesql-downloaded-by-role': role,
    },
  });
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleBundleDownload(context.request, { access: (req) => requireEvidenceAccess(req, context.env), siteUrl: siteOrigin(context.env) });
