import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../../_shared';
import { admin, callerId, jsonRes, membershipOf, type Team, type TeamRole } from '../_shared';
import type { AuditEventRow, AuditEventType } from '../../../../src/services/auditChain';
import { AUDIT_EVENT_TYPES } from '../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — shared pieces for the evidence routes.
//
// Chain WRITES happen on every plan (so history exists the day a team
// upgrades); READING and VERIFYING the chain is the Business feature.

export const EVIDENCE_PLANS: ReadonlySet<string> = new Set(['business', 'enterprise']);
export const EVIDENCE_UPGRADE_URL = '#/pricing';

/** Roles that may read evidence — every seated role, auditor included. */
export type EvidenceRole = TeamRole | 'auditor';

export interface EvidenceAccess {
  db: SupabaseClient;
  team: Team;
  role: EvidenceRole;
  clerkUserId: string;
}

/**
 * Verify the Clerk JWT, resolve the caller's team, and gate on plan.
 * Returns a Response (401 / 404 / 402) when access is denied.
 */
export async function requireEvidenceAccess(request: Request, env: Env): Promise<EvidenceAccess | Response> {
  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);
  const db = admin(env);
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You are not a member of a team' }, 404);
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
