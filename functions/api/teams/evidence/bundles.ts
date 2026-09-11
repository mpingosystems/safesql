import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { BUNDLE_WRITER_ROLES, requireEvidenceAccess, signingKeyFor, type EvidenceAccess } from './_shared';
import { keyFingerprint } from '../../../../src/services/evidenceBundle';

// Sprint 9 (compliance tier) — GET /api/teams/evidence/bundles
// Every seated role sees the team's bundle manifests (the stored rows, never
// key material), newest first, cursor-paged on created_at.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const BUNDLE_COLUMNS =
  'id, team_id, period_from, period_to, chain_from_seq, chain_to_seq, chain_head_hash, event_count, validation_count, approval_count, bundle_hash, signature, signing_key_version, generated_by, generated_by_role, format_version, created_at';

export interface BundlesListDeps {
  access(request: Request): Promise<EvidenceAccess | Response>;
}

export async function handleBundlesList(request: Request, deps: BundlesListDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role } = access;

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return jsonRes({ error: 'limit must be a positive integer' }, 400);
  const limit = Math.min(limitRaw, MAX_LIMIT);
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && Number.isNaN(Date.parse(cursor))) return jsonRes({ error: 'cursor must be an ISO timestamp' }, 400);

  let q = db.from('evidence_bundles').select(BUNDLE_COLUMNS).eq('team_id', team.id).order('created_at', { ascending: false }).limit(limit);
  if (cursor) q = q.lt('created_at', cursor);
  const { data, error } = await q;
  if (error) return jsonRes({ error: `Could not read bundles: ${error.message}` }, 500);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  const clerkIds = [...new Set(rows.map((r) => String(r.generated_by)))];
  const emails = new Map<string, string>();
  if (clerkIds.length > 0) {
    const { data: members } = await db.from('team_members').select('clerk_user_id, email').eq('team_id', team.id).in('clerk_user_id', clerkIds);
    for (const m of (members ?? []) as Array<{ clerk_user_id: string; email: string }>) emails.set(m.clerk_user_id, m.email);
  }

  const key = await signingKeyFor(db, team.id);
  return jsonRes(
    {
      team_id: team.id,
      my_role: role,
      can_generate: BUNDLE_WRITER_ROLES.has(role),
      rows: rows.map((r) => ({ ...r, generated_by_email: emails.get(String(r.generated_by)) ?? null })),
      next_cursor: rows.length === limit ? String(rows[rows.length - 1].created_at) : null,
      signing_key: key ? { version: key.version, fingerprint: await keyFingerprint(key.key_hex) } : null,
    },
    200,
  );
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleBundlesList(context.request, { access: (req) => requireEvidenceAccess(req, context.env) });
