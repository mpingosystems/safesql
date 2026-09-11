import type { Env } from '../../_shared';
import { admin, callerId, jsonRes, membershipOf, preflight, seatUsage, isWriteRole } from './_shared';
import { appendAuditEvent, type AuditActorRole } from '../../../src/services/auditChain';

// Sprint 6B — DELETE /api/teams/member. Removes a member and releases the seat.
//
// Removal also drops the member back to `free`. If a seat grants Pro on accept
// but removal leaves the plan raised, anyone invited once keeps Pro forever and
// the seat cap stops meaning anything commercially.

export const onRequestOptions = preflight;

export const onRequestDelete = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Authentication required' }, 401);

  // DELETE with a body is legal and is what the browser client sends; fall back
  // to a query parameter so the route is curl-friendly.
  let target = '';
  try {
    const body = (await request.json()) as { clerk_user_id?: unknown };
    if (typeof body.clerk_user_id === 'string') target = body.clerk_user_id.trim();
  } catch {
    /* no body — try the query string */
  }
  if (!target) {
    target = new URL(request.url).searchParams.get('clerk_user_id')?.trim() ?? '';
  }
  if (!target) return jsonRes({ error: 'clerk_user_id is required' }, 400);

  const db = admin(env);

  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You do not belong to a team' }, 403);
  const { team, role } = membership;

  const removingSelf = target === clerkUserId;

  // An owner removing themselves would leave a team whose RLS nobody satisfies:
  // teams are readable only through team_members. Transfer ownership first.
  if (removingSelf && role === 'owner') {
    return jsonRes(
      { error: 'An owner cannot remove themselves. Transfer ownership to another member first.' },
      403,
    );
  }
  // Anyone may leave; only owner/manager may remove someone else (auditors are read-only).
  if (!removingSelf && (role === 'member' || !isWriteRole(role))) {
    return jsonRes({ error: 'Only an owner or manager can remove members' }, 403);
  }

  const { data: victim } = await db
    .from('team_members')
    .select('id, clerk_user_id, role, email')
    .eq('team_id', team.id)
    .eq('clerk_user_id', target)
    .maybeSingle();
  if (!victim) return jsonRes({ error: 'That person is not on this team' }, 404);

  // A manager must not be able to remove the owner.
  if (victim.role === 'owner' && !removingSelf) {
    return jsonRes({ error: 'The team owner cannot be removed' }, 403);
  }

  const { error: delErr } = await db.from('team_members').delete().eq('id', victim.id);
  if (delErr) return jsonRes({ error: `Could not remove member: ${delErr.message}` }, 500);

  // Release the seat's entitlement. Skipped for the owner (they are the
  // subscriber) — only reachable when an owner removes themselves, which is
  // blocked above, but guarded here so a future ownership-transfer path is safe.
  let planRevoked = false;
  if (victim.role !== 'owner') {
    const { error: planErr } = await db
      .from('users')
      .update({ plan: 'free' })
      .eq('clerk_user_id', target);
    planRevoked = !planErr;
  }

  // Chain: who lost access, removed by whom. Never blocks the removal.
  try {
    await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'member_removed',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: target,
      payload: { member: target, email: victim.email, role: victim.role, self_removal: removingSelf, plan_revoked: planRevoked },
    });
  } catch (e) {
    console.warn('member_removed chain event not recorded', (e as Error).message);
  }

  // Their past validations stay with the team: removing a person should not
  // rewrite the team's history.
  return jsonRes({
    ok: true,
    removed: { clerk_user_id: target, email: victim.email, role: victim.role },
    planRevoked,
    seats: await seatUsage(db, team),
  });
};
