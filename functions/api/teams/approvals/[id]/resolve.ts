import type { Env } from '../../../../_shared';
import { jsonRes, preflight } from '../../_shared';
import { activePolicies, requireApprovalAccess, sha256Hex, statusForGuardError, userByClerkId, type ApprovalAccess } from '../_shared';
import { DEFAULT_APPROVER_ROLES, canResolve, type ApproverRole } from '../../../../../src/services/approvalPolicy';
import { appendAuditEvent, type AuditActorRole } from '../../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — POST /api/teams/approvals/:id/resolve
//
// A human decision, recorded so it can be proven later. Three rules, each
// enforced here AND by the approval_requests_guard trigger:
//   1. the requester may not resolve their own request (separation of duties)
//   2. only a role the matched policy names may resolve (owner / manager)
//   3. a request is resolved exactly once (WHERE status='pending' + trigger)
// Order of writes: UPDATE the row → append the chain event → write the
// event's seq back (the one post-resolution change the guard permits). If the
// UPDATE loses a race, nothing reaches the chain.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveDeps {
  access(request: Request): Promise<ApprovalAccess | Response>;
}

interface Body {
  decision?: unknown;
  note?: unknown;
}

export function approvalIdFromPath(pathname: string): string | null {
  const m = /\/api\/teams\/approvals\/([^/]+)\/resolve\/?$/.exec(pathname);
  return m && UUID_RE.test(m[1]) ? m[1] : null;
}

export async function handleResolve(request: Request, deps: ResolveDeps): Promise<Response> {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);
  const id = approvalIdFromPath(new URL(request.url).pathname);
  if (!id) return jsonRes({ error: 'approval id must be a UUID' }, 400);

  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    return jsonRes({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }
  const decision = body.decision;
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;

  // Scoped to the caller's team: another team's id is simply "not found".
  const { data: req } = await db
    .from('approval_requests')
    .select('id, status, requester_clerk_user_id, requester_id, policy_id, sql, dialect, risk_score, trigger_reasons, approver_clerk_user_id, resolved_at')
    .eq('id', id)
    .eq('team_id', team.id)
    .maybeSingle();
  if (!req) return jsonRes({ error: 'Approval request not found' }, 404);

  if (req.status !== 'pending') {
    return jsonRes(
      { error: `Request already ${req.status} by ${req.approver_clerk_user_id ?? 'unknown'} at ${req.resolved_at ?? 'unknown'}`, status: req.status },
      409,
    );
  }

  // Rule 1 — separation of duties, checked before any write.
  if (req.requester_clerk_user_id === clerkUserId) {
    return jsonRes({ error: 'Separation of duties: the requester cannot resolve their own request' }, 403);
  }
  // Rule 2 — role, per the matched policy (or the default owner/manager).
  const policies = await activePolicies(db, team.id);
  const approverRoles: ApproverRole[] = (req.policy_id && policies.find((p) => p.id === req.policy_id)?.approver_roles) || DEFAULT_APPROVER_ROLES;
  if (!canResolve(role, approverRoles)) {
    return jsonRes({ error: `Only ${approverRoles.join(' or ')} may resolve this request (you are ${role})`, approver_roles: approverRoles }, 403);
  }

  // Rule 3 — exactly once. WHERE status='pending' makes a concurrent resolve
  // update zero rows; the guard trigger backstops every rule above.
  const approver = await userByClerkId(db, clerkUserId);
  const resolvedAt = new Date().toISOString();
  const { data: updated, error: updErr } = await db
    .from('approval_requests')
    .update({
      status: decision,
      approver_id: approver.id,
      approver_clerk_user_id: clerkUserId,
      approver_role: role,
      approver_note: note,
      resolved_at: resolvedAt,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (updErr) return jsonRes({ error: updErr.message }, statusForGuardError(updErr.message));
  if (!updated) return jsonRes({ error: 'Request was resolved by someone else a moment ago' }, 409);

  // Chain: approval_approved / approval_rejected, then record its seq on the row.
  let seq: number | null = null;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: decision === 'approved' ? 'approval_approved' : 'approval_rejected',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: id,
      payload: {
        approval_id: id,
        sql_hash: await sha256Hex(String(req.sql)),
        dialect: req.dialect,
        risk_score: req.risk_score,
        trigger_reasons: req.trigger_reasons ?? [],
        requester: req.requester_clerk_user_id,
        approver: clerkUserId,
        approver_role: role,
        note_present: !!note,
        resolved_at: resolvedAt,
      },
    });
    await db.from('approval_requests').update({ resolution_event_seq: seq }).eq('id', id);
  } catch (e) {
    console.warn('approval resolution chain event not recorded', (e as Error).message);
  }

  return jsonRes(
    { id, status: decision, approver_clerk_user_id: clerkUserId, approver_role: role, resolved_at: resolvedAt, resolution_event_seq: seq },
    200,
  );
}

export const onRequestOptions = preflight;

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleResolve(context.request, { access: (req) => requireApprovalAccess(req, context.env, { planGated: true }) });
