import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../../_shared';
import { admin, callerId, jsonRes, membershipOf, type Team } from '../_shared';
import type { ApprovalPolicyRow } from '../../../../src/services/approvalPolicy';

// Sprint 9 (compliance tier) — shared pieces for the approvals routes.
//
// Approval REQUESTS are written on every plan (the chain and the request row
// exist the day a team upgrades). The INBOX and RESOLVE are Team+ — the
// approval workflow is sold on the $199 Team card.

export const APPROVAL_PLANS: ReadonlySet<string> = new Set(['team', 'business', 'enterprise']);
export const APPROVAL_UPGRADE_URL = '#/pricing';

export type SeatRole = 'owner' | 'manager' | 'member' | 'auditor';

export interface ApprovalAccess {
  db: SupabaseClient;
  team: Team;
  role: SeatRole;
  clerkUserId: string;
}

/** Verify the Clerk JWT and resolve the caller's team. Optionally gate on plan. */
export async function requireApprovalAccess(
  request: Request,
  env: Env,
  opts: { planGated: boolean },
): Promise<ApprovalAccess | Response> {
  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);
  const db = admin(env);
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You are not a member of a team' }, 404);
  if (opts.planGated && !APPROVAL_PLANS.has(membership.team.plan)) {
    return jsonRes(
      { error: 'The approval workflow is a Team feature', plan: membership.team.plan, upgrade: APPROVAL_UPGRADE_URL },
      402,
    );
  }
  return { db, team: membership.team, role: membership.role as SeatRole, clerkUserId };
}

/** Active policies for a team, in the evaluator's stable order. */
export async function activePolicies(db: SupabaseClient, teamId: string): Promise<ApprovalPolicyRow[]> {
  const { data } = await db
    .from('approval_policies')
    .select('id, team_id, name, active, min_score, detector_ids, require_for_destructive, approver_roles, created_at')
    .eq('team_id', teamId)
    .eq('active', true)
    .order('created_at', { ascending: true });
  return (data ?? []) as ApprovalPolicyRow[];
}

/** users.id + email for a clerk id, or nulls when the account is gone. */
export async function userByClerkId(
  db: SupabaseClient,
  clerkUserId: string,
): Promise<{ id: string | null; email: string | null }> {
  const { data } = await db.from('users').select('id, email').eq('clerk_user_id', clerkUserId).maybeSingle();
  return { id: (data?.id as string | undefined) ?? null, email: (data?.email as string | undefined) ?? null };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Map a guard-trigger failure to the HTTP status a client can act on. */
export function statusForGuardError(message: string): number {
  if (/separation of duties/i.test(message)) return 403;
  if (/only an owner or manager/i.test(message)) return 403;
  if (/immutable|already recorded|cannot change/i.test(message)) return 409;
  return 500;
}
