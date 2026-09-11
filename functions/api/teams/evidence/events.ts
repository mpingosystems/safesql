import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { chainHead, countsByType, intParam, requireEvidenceAccess, toWireRow, type EvidenceAccess } from './_shared';
import { isAuditEventType } from '../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — GET /api/teams/evidence/events
//
// Paged, unmodified chain rows for the caller's team. One shape feeds the
// UI, the evidence-bundle builder and any offline verifier: exactly the
// stored columns, so what a reader downloads is what the hashes cover.
//
//   ?from=<seq>  ?to=<seq>  ?type=<AuditEventType>  ?limit=1..1000  ?cursor=<last seq seen>

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export interface EvidenceEventsDeps {
  access(request: Request): Promise<EvidenceAccess | Response>;
}

export async function handleEvidenceEvents(request: Request, deps: EvidenceEventsDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team } = access;

  const url = new URL(request.url);
  const from = intParam(url, 'from');
  const to = intParam(url, 'to');
  const cursor = intParam(url, 'cursor');
  const limitRaw = intParam(url, 'limit');
  if ([from, to, cursor, limitRaw].some((v) => v !== undefined && Number.isNaN(v))) {
    return jsonRes({ error: 'from, to, cursor and limit must be non-negative integers' }, 400);
  }
  if (from !== undefined && to !== undefined && to < from) return jsonRes({ error: 'to must be >= from' }, 400);
  const limit = Math.min(Math.max(limitRaw ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const type = url.searchParams.get('type');
  if (type !== null && !isAuditEventType(type)) return jsonRes({ error: `unknown event type "${type}"` }, 400);

  let q = db.from('audit_events').select('*').eq('team_id', team.id).order('seq', { ascending: true }).limit(limit);
  const lower = Math.max(from ?? 1, cursor !== undefined ? cursor + 1 : 1);
  q = q.gte('seq', lower);
  if (to !== undefined) q = q.lte('seq', to);
  if (type) q = q.eq('event_type', type);

  const { data, error } = await q;
  if (error) return jsonRes({ error: `Could not read chain: ${error.message}` }, 500);

  const rows = ((data ?? []) as Record<string, unknown>[]).map(toWireRow);
  const [head, counts_by_type] = await Promise.all([chainHead(db, team.id), countsByType(db, team.id)]);
  const next_cursor = rows.length === limit ? rows[rows.length - 1].seq : null;

  return jsonRes({ team_id: team.id, rows, next_cursor, head, counts_by_type }, 200);
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleEvidenceEvents(context.request, { access: (req) => requireEvidenceAccess(req, context.env) });
