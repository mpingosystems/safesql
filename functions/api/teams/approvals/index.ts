import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { activePolicies, requireApprovalAccess, type ApprovalAccess } from './_shared';
import { DEFAULT_APPROVER_ROLES, canResolve, type ApproverRole } from '../../../../src/services/approvalPolicy';

// Sprint 9 (compliance tier) — GET /api/teams/approvals  (the inbox)
//
// Every seated role can read the team's requests (auditor included). Whether
// the caller may resolve a given row is computed HERE, per row, from the
// matched policy's approver_roles and the separation-of-duties rule, so the
// UI never has to guess and the resolve route re-checks the same facts.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected', 'all']);

export interface ApprovalsInboxDeps {
  access(request: Request): Promise<ApprovalAccess | Response>;
}

export async function handleApprovalsInbox(request: Request, deps: ApprovalsInboxDeps): Promise<Response> {
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? 'pending';
  if (!STATUSES.has(status)) return jsonRes({ error: 'status must be pending | approved | rejected | all' }, 400);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return jsonRes({ error: 'limit must be a positive integer' }, 400);
  const limit = Math.min(limitRaw, MAX_LIMIT);
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && Number.isNaN(Date.parse(cursor))) return jsonRes({ error: 'cursor must be an ISO timestamp' }, 400);

  let q = db
    .from('approval_requests')
    .select('id, status, requester_id, requester_clerk_user_id, approver_id, approver_clerk_user_id, approver_role, sql, ddl, dialect, risk_score, validation_report, trigger_reasons, policy_id, requester_note, approver_note, created_at, resolved_at, request_event_seq, resolution_event_seq')
    .eq('team_id', team.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status !== 'all') q = q.eq('status', status);
  if (cursor) q = q.lt('created_at', cursor);
  const { data, error } = await q;
  if (error) return jsonRes({ error: `Could not read approvals: ${error.message}` }, 500);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Policy roles per request (for can_resolve_this) + emails for display.
  const policies = await activePolicies(db, team.id);
  const rolesByPolicy = new Map<string, ApproverRole[]>(policies.map((p) => [p.id, p.approver_roles]));
  const clerkIds = new Set<string>();
  for (const r of rows) {
    if (typeof r.requester_clerk_user_id === 'string') clerkIds.add(r.requester_clerk_user_id);
    if (typeof r.approver_clerk_user_id === 'string') clerkIds.add(r.approver_clerk_user_id);
  }
  const emails = new Map<string, string>();
  if (clerkIds.size > 0) {
    const { data: members } = await db.from('team_members').select('clerk_user_id, email').eq('team_id', team.id).in('clerk_user_id', [...clerkIds]);
    for (const m of (members ?? []) as Array<{ clerk_user_id: string; email: string }>) emails.set(m.clerk_user_id, m.email);
  }

  const out = rows.map((r) => {
    const approverRoles: ApproverRole[] =
      (typeof r.policy_id === 'string' ? rolesByPolicy.get(r.policy_id) : undefined) ?? DEFAULT_APPROVER_ROLES;
    const isRequester = r.requester_clerk_user_id === clerkUserId;
    return {
      ...(r as Record<string, unknown> & { created_at: string; status: string }),
      requester_email: emails.get(String(r.requester_clerk_user_id)) ?? null,
      approver_email: r.approver_clerk_user_id ? emails.get(String(r.approver_clerk_user_id)) ?? null : null,
      approver_roles: approverRoles,
      can_resolve_this: r.status === 'pending' && !isRequester && canResolve(role, approverRoles),
    };
  });

  const canResolveAny = canResolve(role, DEFAULT_APPROVER_ROLES) || policies.some((p) => canResolve(role, p.approver_roles));
  const next_cursor = out.length === limit ? String(out[out.length - 1].created_at) : null;
  return jsonRes({ team_id: team.id, my_role: role, can_resolve: canResolveAny, rows: out, next_cursor }, 200);
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleApprovalsInbox(context.request, { access: (req) => requireApprovalAccess(req, context.env, { planGated: true }) });
