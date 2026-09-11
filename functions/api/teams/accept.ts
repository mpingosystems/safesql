import type { Env } from '../../_shared';
import { admin, callerId, jsonRes, preflight, seatUsage } from './_shared';

// Sprint 6B — POST /api/teams/accept. Redeems an invitation token.
//
// Also grants the seat: the joining member's users.plan is raised to the team's
// plan. Without that step an invited member is seated but still on `free`,
// running 12 of 35 detectors — which is what "5 seats" is supposed to buy.

export const onRequestOptions = preflight;

export const onRequestPost = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Authentication required' }, 401);

  let body: { token?: unknown; email?: unknown; display_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return jsonRes({ error: 'token is required' }, 400);

  const db = admin(env);

  const { data: invite } = await db
    .from('team_invitations')
    .select('id, team_id, email, role, accepted_at, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (!invite) return jsonRes({ error: 'Invitation not found' }, 404);
  if (invite.accepted_at) return jsonRes({ error: 'This invitation has already been used' }, 409);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return jsonRes({ error: 'This invitation has expired' }, 409);
  }

  const { data: team } = await db
    .from('teams')
    .select('id, name, slug, plan, created_by, created_at')
    .eq('id', invite.team_id)
    .maybeSingle();
  if (!team) return jsonRes({ error: 'Team no longer exists' }, 404);

  // Idempotent: re-posting the same token after success returns the team rather
  // than erroring, so a double-submit or a refreshed tab is harmless.
  const { data: already } = await db
    .from('team_members')
    .select('id, role')
    .eq('team_id', team.id)
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  if (already) {
    await db
      .from('team_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);
    return jsonRes({ team, role: already.role, alreadyMember: true }, 200);
  }

  // Belongs to a different team already? Seats are one-per-user.
  const { data: otherMembership } = await db
    .from('team_members')
    .select('team_id')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (otherMembership && otherMembership.team_id !== team.id) {
    return jsonRes({ error: 'You already belong to another team. Leave it first.' }, 409);
  }

  const seats = await seatUsage(db, team);
  // The pending invitation being redeemed already counts toward `used`, so the
  // team is only genuinely full when members alone have reached the limit.
  if (seats.limit !== null && seats.members >= seats.limit) {
    return jsonRes(
      { error: `This team is full (${seats.members} of ${seats.limit} seats).`, seats },
      409,
    );
  }

  const email =
    typeof body.email === 'string' && body.email.trim()
      ? body.email.trim().toLowerCase()
      : invite.email;

  const { error: seatErr } = await db.from('team_members').insert({
    team_id: team.id,
    clerk_user_id: clerkUserId,
    role: invite.role ?? 'member',
    email,
    display_name: typeof body.display_name === 'string' ? body.display_name.trim() : null,
    invited_by: null,
    joined_at: new Date().toISOString(),
  });

  if (seatErr) {
    const capped = /seat limit/i.test(seatErr.message);
    return jsonRes({ error: capped ? seatErr.message : `Could not join: ${seatErr.message}` }, capped ? 409 : 500);
  }

  await db
    .from('team_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id);

  // Grant the seat. Best-effort and reported back: a member who is seated but
  // not upgraded is a support ticket, so the caller should know if it failed.
  const { error: planErr } = await db
    .from('users')
    .update({ plan: team.plan })
    .eq('clerk_user_id', clerkUserId);

  return jsonRes(
    { team, role: invite.role ?? 'member', planGranted: !planErr, plan: team.plan },
    200,
  );
};
