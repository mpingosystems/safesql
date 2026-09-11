import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../_shared';
import { verifyClerkJWT } from '../_shared/clerkAuth';

// Sprint 6B — shared helpers for the /api/teams/* routes.
//
// These routes use the SERVICE ROLE key, which bypasses RLS. Every one of them
// therefore has to do its own authorization: verify the Clerk JWT, then check
// the caller's membership and role before touching anything. RLS is the second
// line of defence for the browser client, not the first line for these routes.
//
// Identity is `clerk_user_id` everywhere (team_members.clerk_user_id), matching
// auth.jwt()->>'sub'. The `users` table is only consulted where a row needs a
// users.id UUID — validations.user_id is a UUID, not a Clerk id.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}

export const preflight = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export function admin(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Clerk user id from a verified session JWT, or null. */
export async function callerId(request: Request, env: Env): Promise<string | null> {
  return verifyClerkJWT(request, env);
}

export type TeamRole = 'owner' | 'manager' | 'member' | 'auditor';

// Sprint 9 (compliance): the auditor is a read-only seat — audit trail, chain,
// evidence bundles and the approvals inbox, plus export. No requests, no
// approvals, no invites, no role changes, no rule/policy edits, and no chain
// writes attributed to them from the browser. It occupies a seat.
export const READ_ONLY_ROLES: ReadonlySet<string> = new Set(['auditor']);
export const ALL_ROLES: ReadonlySet<string> = new Set(['owner', 'manager', 'member', 'auditor']);
/** Roles an owner or manager may hand out (owner is never assigned — it is the founder). */
export const ASSIGNABLE_ROLES: ReadonlySet<string> = new Set(['manager', 'member', 'auditor']);
export function isWriteRole(role: string): boolean {
  return !READ_ONLY_ROLES.has(role);
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_by: string;
  created_at?: string;
}

export interface Membership {
  team: Team;
  role: TeamRole;
}

/** The caller's team and role, or null if they belong to no team. */
export async function membershipOf(
  db: SupabaseClient,
  clerkUserId: string,
): Promise<Membership | null> {
  const { data: m } = await db
    .from('team_members')
    .select('team_id, role')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (!m?.team_id) return null;

  const { data: t } = await db
    .from('teams')
    .select('id, name, slug, plan, created_by, created_at')
    .eq('id', m.team_id)
    .maybeSingle();
  if (!t) return null;

  return { team: t as Team, role: (m.role as TeamRole) ?? 'member' };
}

/** Seats for a plan. null = uncapped. Mirrors seat_limit_for_plan() in SQL. */
export function seatLimitForPlan(plan: string): number | null {
  if (plan === 'team') return 5;
  if (plan === 'business') return 20;
  return null;
}

export interface SeatUsage {
  members: number;
  pendingInvites: number;
  used: number;
  limit: number | null;
  full: boolean;
}

/**
 * Seats consumed = seated members + live pending invitations. Counting members
 * alone would let an owner issue 4 invitations against 1 free seat.
 *
 * The DB trigger enforces the same rule; this is the belt to its braces, and it
 * exists so the API can return a readable 409 instead of surfacing a raw
 * Postgres check_violation.
 */
export async function seatUsage(db: SupabaseClient, team: Team): Promise<SeatUsage> {
  const limit = seatLimitForPlan(team.plan);

  const { count: memberCount } = await db
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', team.id);

  const { count: inviteCount } = await db
    .from('team_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', team.id)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString());

  const members = memberCount ?? 0;
  const pendingInvites = inviteCount ?? 0;
  const used = members + pendingInvites;
  return { members, pendingInvites, used, limit, full: limit !== null && used >= limit };
}

/**
 * Best-effort Resend send. Mirrors the helper in stripe/webhook.ts, but accepts
 * a text alternative: an HTML-only message scores worse with spam filters and
 * renders as nothing in clients configured to refuse HTML.
 */
export async function sendEmail(
  env: Env,
  to: string | undefined,
  subject: string,
  body: string | { html: string; text?: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'SafeSQL Pro <noreply@safesqlpro.dev>',
        to,
        subject,
        html: typeof body === 'string' ? body : body.html,
        ...(typeof body === 'object' && body.text ? { text: body.text } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false; // invitation still exists; the owner can copy the link
  }
}

export function siteOrigin(env: Env): string {
  return env.SITE_URL || 'https://safesqlpro.dev';
}

/** URL-safe slug. Collisions are resolved by the caller with a numeric suffix. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'team'
  );
}

/** Cryptographically random invitation token (URL-safe, 24 chars). */
export function inviteToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
