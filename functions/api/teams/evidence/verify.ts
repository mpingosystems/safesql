import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { chainHead, countsByType, intParam, requireEvidenceAccess, toWireRow, type EvidenceAccess } from './_shared';
import { verifyChain, type ChainVerification } from '../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — GET /api/teams/evidence/verify
//
// Two independent verifications of the same chain segment:
//   db    — verify_audit_chain() running inside Postgres
//   local — verifyChain() in this Worker over the rows it fetched
// and an `agree` flag. An auditor does not have to trust either
// implementation alone; if they ever disagree, that is itself the finding.
//
// HTTP 200 is returned even when ok=false — a broken chain is a successful
// verification with a negative result, not a request failure.

const MAX_RANGE = 50_000;
const PAGE = 1000;

export interface EvidenceVerifyDeps {
  access(request: Request): Promise<EvidenceAccess | Response>;
}

/** verify_audit_chain() returns snake_case; the response speaks the TS shape. */
function fromDbVerification(row: Record<string, unknown> | null | undefined): ChainVerification {
  if (!row) return { ok: false, checked: 0, reason: 'verify_audit_chain returned no row' };
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  const out: ChainVerification = { ok: row.ok === true, checked: Number(row.checked ?? 0) };
  const firstSeq = num(row.first_seq); if (firstSeq !== undefined) out.firstSeq = firstSeq;
  const lastSeq = num(row.last_seq); if (lastSeq !== undefined) out.lastSeq = lastSeq;
  const headHash = str(row.head_hash); if (headHash !== undefined) out.headHash = headHash;
  const firstBad = num(row.first_bad_seq); if (firstBad !== undefined) out.firstBadSeq = firstBad;
  const expected = str(row.expected_hash); if (expected !== undefined) out.expectedHash = expected;
  const actual = str(row.actual_hash); if (actual !== undefined) out.actualHash = actual;
  const reason = str(row.reason); if (reason !== undefined) out.reason = reason;
  return out;
}

export async function handleEvidenceVerify(request: Request, deps: EvidenceVerifyDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team } = access;

  const url = new URL(request.url);
  const fromParam = intParam(url, 'from');
  const toParam = intParam(url, 'to');
  if ([fromParam, toParam].some((v) => v !== undefined && Number.isNaN(v))) {
    return jsonRes({ error: 'from and to must be non-negative integers' }, 400);
  }
  const head = await chainHead(db, team.id);
  const from_seq = Math.max(fromParam ?? 1, 1);
  const to_seq = toParam ?? head?.seq ?? 0;
  if (to_seq < from_seq && head) return jsonRes({ error: 'to must be >= from' }, 400);
  if (to_seq - from_seq + 1 > MAX_RANGE) {
    return jsonRes({ error: `Range exceeds ${MAX_RANGE} events — verify in pages (from/to)` }, 413);
  }

  // 1. Postgres verifies.
  const { data: dbRows, error: dbErr } = await db.rpc('verify_audit_chain', {
    p_team_id: team.id,
    p_from_seq: from_seq,
    p_to_seq: to_seq,
  });
  if (dbErr) return jsonRes({ error: `verify_audit_chain failed: ${dbErr.message}` }, 500);
  const dbRow = Array.isArray(dbRows) ? (dbRows[0] as Record<string, unknown> | undefined) : (dbRows as Record<string, unknown> | null);
  const dbResult = fromDbVerification(dbRow);

  // 2. This Worker verifies, over the rows it fetched itself, page by page.
  const rows = [];
  for (let lower = from_seq; lower <= to_seq; lower += PAGE) {
    const upper = Math.min(lower + PAGE - 1, to_seq);
    const { data, error } = await db
      .from('audit_events')
      .select('*')
      .eq('team_id', team.id)
      .gte('seq', lower)
      .lte('seq', upper)
      .order('seq', { ascending: true });
    if (error) return jsonRes({ error: `Could not read chain: ${error.message}` }, 500);
    rows.push(...((data ?? []) as Record<string, unknown>[]).map(toWireRow));
    if (!data || data.length === 0) break;
  }
  const local = await verifyChain(rows);

  const agree =
    dbResult.ok === local.ok &&
    dbResult.checked === local.checked &&
    (dbResult.headHash ?? null) === (local.headHash ?? null) &&
    (dbResult.firstBadSeq ?? null) === (local.firstBadSeq ?? null);

  const by_type = await countsByType(db, team.id);
  const events = Object.values(by_type).reduce((a, b) => a + b, 0);

  return jsonRes(
    {
      team_id: team.id,
      from_seq,
      to_seq,
      db: dbResult,
      local,
      agree,
      head,
      counts: { events, by_type },
      checked_at: new Date().toISOString(),
    },
    200,
  );
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleEvidenceVerify(context.request, { access: (req) => requireEvidenceAccess(req, context.env) });
