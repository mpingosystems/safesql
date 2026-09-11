import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../../_shared';
import { ASSIGNABLE_ROLES, admin, callerId, jsonRes, membershipOf, preflight, type TeamRole } from '../_shared';
import { appendAuditEvent, type AuditActorRole } from '../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — PATCH /api/teams/member/role
//
// The only way a seat's role changes. Previously the TeamMembers page ran a
// browser UPDATE on team_members (RLS-gated, unaudited); now the server
// decides and every change lands on the chain as member_role_changed, so the
// evidence trail can answer "who had which access when".
//
// Matrix:
//   owner    → may set manager | member | auditor on anyone but themselves
//   manager  → may set member | auditor on members/auditors (never on the
//              owner or another manager, never promote to manager)
//   member / auditor → 403
// Owner is never assignable; ownership transfer is a separate concern.

export interface RoleChangeDeps {
  callerId(request: Request): Promise<string | null>;
  db(): SupabaseClient;
}

interface Body {
  clerk_user_id?: unknown;
  role?: unknown;
}

export function roleChangeError(
  callerRole: TeamRole,
  callerId: string,
  target: { clerk_user_id: string; role: string },
  newRole: string,
): { status: number; error: string } | null {
  if (!ASSIGNABLE_ROLES.has(newRole)) return { status: 400, error: 'role must be manager, member or auditor' };
  if (target.clerk_user_id === callerId) return { status: 403, error: 'You cannot change your own role' };
  if (target.role === 'owner') return { status: 403, error: "The owner's role cannot be changed" };
  if (target.role === newRole) return { status: 409, error: `Already ${newRole}` };
  if (callerRole === 'owner') return null;
  if (callerRole === 'manager') {
    if (newRole === 'manager') return { status: 403, error: 'Only the owner can promote to manager' };
    if (target.role === 'manager') return { status: 403, error: "Only the owner can change a manager's role" };
    return null;
  }
  return { status: 403, error: 'Only an owner or manager can change roles' };
}

export async function handleRoleChange(request: Request, deps: RoleChangeDeps): Promise<Response> {
  if (request.method !== 'PATCH') return jsonRes({ error: 'Method not allowed' }, 405);
  const clerkUserId = await deps.callerId(request);
  if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  const target = typeof body.clerk_user_id === 'string' ? body.clerk_user_id.trim() : '';
  const newRole = typeof body.role === 'string' ? body.role : '';
  if (!target) return jsonRes({ error: 'clerk_user_id is required' }, 400);

  const db = deps.db();
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You do not belong to a team' }, 403);
  const { team, role } = membership;

  const { data: victim } = await db
    .from('team_members')
    .select('id, clerk_user_id, role, email')
    .eq('team_id', team.id)
    .eq('clerk_user_id', target)
    .maybeSingle();
  if (!victim) return jsonRes({ error: 'That person is not on this team' }, 404);

  const denied = roleChangeError(role, clerkUserId, victim as { clerk_user_id: string; role: string }, newRole);
  if (denied) return jsonRes({ error: denied.error }, denied.status);
  const fromRole = String(victim.role); // snapshot before the write

  const { error: updErr } = await db.from('team_members').update({ role: newRole }).eq('id', victim.id);
  if (updErr) return jsonRes({ error: `Could not change role: ${updErr.message}` }, 500);

  // Plan entitlement follows the role: a seat demoted to auditor loses the
  // paid plan (read-only, no validation); a seat promoted out of auditor gains it.
  let planChanged: 'granted' | 'revoked' | null = null;
  if (fromRole === 'auditor' && newRole !== 'auditor') {
    const { error } = await db.from('users').update({ plan: team.plan }).eq('clerk_user_id', target);
    if (!error) planChanged = 'granted';
  } else if (fromRole !== 'auditor' && newRole === 'auditor') {
    const { error } = await db.from('users').update({ plan: 'free' }).eq('clerk_user_id', target);
    if (!error) planChanged = 'revoked';
  }

  let seq: number | null = null;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'member_role_changed',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: target,
      payload: { member: target, email: victim.email, from: fromRole, to: newRole, plan_changed: planChanged },
    });
  } catch (e) {
    console.warn('member_role_changed chain event not recorded', (e as Error).message);
  }

  return jsonRes({ ok: true, member: { clerk_user_id: target, email: victim.email, role: newRole }, from: fromRole, plan_changed: planChanged, event_seq: seq }, 200);
}

export const onRequestOptions = preflight;

export const onRequestPatch = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleRoleChange(context.request, { callerId: (req) => callerId(req, context.env), db: () => admin(context.env) });
