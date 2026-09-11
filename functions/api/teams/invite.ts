import type { Env } from '../../_shared';
import {
  admin,
  callerId,
  inviteToken,
  isWriteRole,
  jsonRes,
  membershipOf,
  preflight,
  seatUsage,
  sendEmail,
  siteOrigin,
} from './_shared';
import {
  acceptInviteUrl,
  inviteEmailHtml,
  inviteEmailText,
  inviteSubject,
} from './inviteEmail';

// Sprint 6B — POST /api/teams/invite. Creates an invitation and emails the link.
//
// Email-based invites only: no magic-link auth. The email carries a token that
// resolves at #/team/join?token=…, which JoinTeam.tsx and the accept route
// already understand.

export const onRequestOptions = preflight;

export const onRequestPost = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Authentication required' }, 401);

  let body: { email?: unknown; role?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonRes({ error: 'A valid email is required' }, 400);
  }
  // Sprint 9 (compliance): 'auditor' is a read-only seat. Owner is never invited.
  const role = body.role === 'manager' ? 'manager' : body.role === 'auditor' ? 'auditor' : 'member';

  const db = admin(env);

  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You do not belong to a team' }, 403);
  if (membership.role === 'member' || !isWriteRole(membership.role)) {
    return jsonRes({ error: 'Only an owner or manager can invite members' }, 403);
  }
  const { team } = membership;

  // Already seated?
  const { data: seated } = await db
    .from('team_members')
    .select('id')
    .eq('team_id', team.id)
    .eq('email', email)
    .maybeSingle();
  if (seated) return jsonRes({ error: `${email} is already on this team` }, 409);

  // Live invitation already outstanding? Return it rather than burning a seat
  // on a duplicate — the caller can resend the same link.
  const { data: outstanding } = await db
    .from('team_invitations')
    .select('id, email, role, token, expires_at, created_at')
    .eq('team_id', team.id)
    .eq('email', email)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (outstanding) {
    return jsonRes({ invite: outstanding, resent: false, alreadyPending: true }, 200);
  }

  // API-level seat check. The DB trigger enforces the same rule; this exists so
  // the caller gets a readable 409 rather than a raw check_violation.
  const seats = await seatUsage(db, team);
  if (seats.full) {
    return jsonRes(
      {
        error: `Seat limit reached: ${seats.used} of ${seats.limit} seats in use (${seats.members} members, ${seats.pendingInvites} pending invitations). Remove a member or revoke an invitation first.`,
        seats,
      },
      409,
    );
  }

  const token = inviteToken();
  const { data: invite, error } = await db
    .from('team_invitations')
    .insert({ team_id: team.id, email, role, token, invited_by: clerkUserId })
    .select('id, email, role, token, expires_at, created_at')
    .single();

  if (error || !invite) {
    // The trigger fires here if the API check raced another invitation.
    const capped = /seat limit/i.test(error?.message ?? '');
    return jsonRes(
      { error: capped ? error!.message : `Could not create invitation: ${error?.message}` },
      capped ? 409 : 500,
    );
  }

  // Inviter display name for the email; fall back to their email, then to a
  // neutral phrase, so the copy never renders "undefined has invited you".
  const { data: inviter } = await db
    .from('team_members')
    .select('display_name, email')
    .eq('team_id', team.id)
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  const inviterName = inviter?.display_name || inviter?.email || 'A teammate';

  const acceptUrl = acceptInviteUrl(siteOrigin(env), token);
  const emailed = await sendEmail(env, email, inviteSubject(team.name), {
    html: inviteEmailHtml({ teamName: team.name, inviterName, acceptUrl }),
    text: inviteEmailText({ teamName: team.name, inviterName, acceptUrl }),
  });

  // Best-effort email: the invitation exists either way, and the UI shows the
  // link so an owner can send it by hand when Resend is unconfigured.
  return jsonRes({ invite, emailed, acceptUrl, seats: await seatUsage(db, team) }, 201);
};
