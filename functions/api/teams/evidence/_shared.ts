import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../../_shared';
import { admin, callerId, jsonRes, membershipOf, type Team, type TeamRole } from '../_shared';
import type { AuditEventRow, AuditEventType } from '../../../../src/services/auditChain';
import { AUDIT_EVENT_TYPES } from '../../../../src/services/auditChain';
import { API_KEY_PREFIX, hashApiKey } from '../../../../src/services/apiKeys';

// Sprint 9 (compliance tier) — shared pieces for the evidence routes.
//
// Chain WRITES happen on every plan (so history exists the day a team
// upgrades); READING and VERIFYING the chain is the Business feature.

export const EVIDENCE_PLANS: ReadonlySet<string> = new Set(['business', 'enterprise']);
export const EVIDENCE_UPGRADE_URL = '#/pricing';

/** Roles that may read evidence — every seated role, auditor included. */
export type EvidenceRole = TeamRole; // 'auditor' is now part of TeamRole

export interface EvidenceAccess {
  db: SupabaseClient;
  team: Team;
  role: EvidenceRole;
  clerkUserId: string;
}

// Sprint 9.5A-post — the evidence routes accept a SafeSQL Pro API key as well
// as a Clerk session, so `safesql scan --sign` can generate and download a
// bundle from CI. The key resolves to its owner (api_keys → users, same lookup
// as POST /api/validate, revoked keys rejected) and from there to the owner's
// team membership; plan gating and the role rules are then identical to the
// browser path. `deps` exists for tests only — production call sites pass
// (request, env) and get the real client and verifier.

export interface EvidenceAccessDeps {
  db?: SupabaseClient;
  verifyJwt?: (request: Request, env: Env) => Promise<string | null>;
}

export const API_KEY_NO_TEAM_ERROR = 'API key owner is not a member of any team';

function bearerToken(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** The Clerk user id that owns a live API key, or null (unknown or revoked). */
async function apiKeyOwner(db: SupabaseClient, token: string): Promise<string | null> {
  const keyHash = await hashApiKey(token);
  const { data } = await db
    .from('api_keys')
    .select('user_id, revoked_at, users!inner(plan, clerk_user_id)')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (!data || data.revoked_at) return null;
  type U = { plan?: string; clerk_user_id?: string };
  const embedded = (data as { users?: U | U[] }).users;
  const user = Array.isArray(embedded) ? embedded[0] : embedded;
  return user?.clerk_user_id ?? null;
}

/**
 * Resolve the caller — API key first (`Bearer ssk_live_…`), else Clerk JWT —
 * then the caller's team, and gate on plan.
 * Returns a Response (401 / 404 / 402) when access is denied.
 */
export async function requireEvidenceAccess(
  request: Request,
  env: Env,
  deps: EvidenceAccessDeps = {},
): Promise<EvidenceAccess | Response> {
  const token = bearerToken(request);
  const viaApiKey = token !== null && token.startsWith(API_KEY_PREFIX);
  const db = deps.db ?? admin(env);

  let clerkUserId: string | null;
  if (viaApiKey) {
    clerkUserId = await apiKeyOwner(db, token);
    if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);
  } else {
    clerkUserId = await (deps.verifyJwt ?? callerId)(request, env);
    if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);
  }

  const membership = await membershipOf(db, clerkUserId);
  if (!membership) {
    // A key with no team is an auth failure for a machine caller (401), while
    // a signed-in person with no team is a state the UI explains (404).
    return viaApiKey
      ? jsonRes({ error: API_KEY_NO_TEAM_ERROR }, 401)
      : jsonRes({ error: 'You are not a member of a team' }, 404);
  }
  if (!EVIDENCE_PLANS.has(membership.team.plan)) {
    return jsonRes(
      {
        error: 'Evidence chain access is a Business feature',
        plan: membership.team.plan,
        upgrade: EVIDENCE_UPGRADE_URL,
      },
      402,
    );
  }
  return { db, team: membership.team, role: membership.role as EvidenceRole, clerkUserId };
}

/** Parse a positive integer query param; undefined when absent, NaN when malformed. */
export function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

/** Wire shape of a chain row: bigint → number, timestamps → ISO strings. Nothing else touched. */
export function toWireRow(r: Record<string, unknown>): AuditEventRow {
  return {
    team_id: String(r.team_id),
    seq: Number(r.seq),
    event_type: r.event_type as AuditEventType,
    actor: String(r.actor),
    actor_role: (r.actor_role as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    payload_canonical: String(r.payload_canonical),
    prev_hash: String(r.prev_hash),
    hash: String(r.hash),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    created_at_iso: String(r.created_at_iso),
  };
}

/** Whole-chain event counts by type for a team (a cheap aggregate over the type index). */
export async function countsByType(db: SupabaseClient, teamId: string): Promise<Record<AuditEventType, number>> {
  const counts = Object.fromEntries(AUDIT_EVENT_TYPES.map((t) => [t, 0])) as Record<AuditEventType, number>;
  // PostgREST has no GROUP BY; pull the type column only (tiny) and count in memory.
  const { data } = await db.from('audit_events').select('event_type').eq('team_id', teamId).limit(100_000);
  for (const r of (data ?? []) as Array<{ event_type: string }>) {
    if (r.event_type in counts) counts[r.event_type as AuditEventType] += 1;
  }
  return counts;
}

/** The chain head (highest seq) for a team, or null when the chain is empty. */
export async function chainHead(
  db: SupabaseClient,
  teamId: string,
): Promise<{ seq: number; hash: string; created_at_iso: string } | null> {
  const { data } = await db
    .from('audit_events')
    .select('seq, hash, created_at_iso')
    .eq('team_id', teamId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { seq: Number(data.seq), hash: String(data.hash), created_at_iso: String(data.created_at_iso) };
}

// ── Sprint 9 item 5: bundles ─────────────────────────────────────────────────

/** Roles that may GENERATE a bundle (members may read/download only). */
export const BUNDLE_WRITER_ROLES: ReadonlySet<string> = new Set(['owner', 'manager', 'auditor']);

export interface SigningKey {
  version: number;
  key_hex: string;
  active: boolean;
}

/** The team's active signing key, or a specific version. Service role only. */
export async function signingKeyFor(db: SupabaseClient, teamId: string, version?: number): Promise<SigningKey | null> {
  let q = db.from('team_signing_keys').select('version, key_hex, active').eq('team_id', teamId);
  q = version === undefined ? q.eq('active', true) : q.eq('version', version);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  return { version: Number(data.version), key_hex: String(data.key_hex), active: data.active === true };
}

/** All chain rows in [fromSeq, toSeq], fetched in 1,000-row pages, wire shape. */
export async function fetchChainSegment(db: SupabaseClient, teamId: string, fromSeq: number, toSeq: number): Promise<AuditEventRow[]> {
  const rows: AuditEventRow[] = [];
  for (let lower = fromSeq; lower <= toSeq; lower += 1000) {
    const upper = Math.min(lower + 999, toSeq);
    const { data, error } = await db
      .from('audit_events')
      .select('*')
      .eq('team_id', teamId)
      .gte('seq', lower)
      .lte('seq', upper)
      .order('seq', { ascending: true });
    if (error) throw new Error(`Could not read chain: ${error.message}`);
    const page = ((data ?? []) as Record<string, unknown>[]).map(toWireRow);
    rows.push(...page);
    if (page.length === 0) break;
  }
  return rows;
}

/** First and last seq whose created_at falls in [from, to]; null when the period is empty. */
export async function seqRangeForPeriod(
  db: SupabaseClient,
  teamId: string,
  from: string,
  to: string,
): Promise<{ fromSeq: number; toSeq: number } | null> {
  const first = await db.from('audit_events').select('seq').eq('team_id', teamId).gte('created_at', from).lte('created_at', to).order('seq', { ascending: true }).limit(1).maybeSingle();
  const last = await db.from('audit_events').select('seq').eq('team_id', teamId).gte('created_at', from).lte('created_at', to).order('seq', { ascending: false }).limit(1).maybeSingle();
  if (!first.data || !last.data) return null;
  return { fromSeq: Number(first.data.seq), toSeq: Number(last.data.seq) };
}

export async function memberEmail(db: SupabaseClient, teamId: string, clerkUserId: string): Promise<string | null> {
  const { data } = await db.from('team_members').select('email').eq('team_id', teamId).eq('clerk_user_id', clerkUserId).maybeSingle();
  return (data?.email as string | undefined) ?? null;
}
