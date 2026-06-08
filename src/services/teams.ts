import { nanoid, customAlphabet } from 'nanoid';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

// Lowercase-alphanumeric suffix for slugs (avoids nanoid's default `_`/`-`,
// keeping slugs cleanly url-safe and matching the slug regex).
const slugSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

// Sprint 9 Part 1 — Teams model. Resolves the Sprint 8 gap where every Team-tier
// feature ran as a single-user stand-in. DB ops take an injectable Supabase
// client (default: the app singleton) so they're unit-testable with a fake,
// matching the approvals.ts / sharedValidation.ts convention.

export type TeamPlan = 'team' | 'business' | 'enterprise';
export type TeamRole = 'owner' | 'manager' | 'member';

export interface Team {
  id: string;
  name: string;
  slug: string;
  plan: TeamPlan;
  created_by: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  clerk_user_id: string;
  role: TeamRole;
  email: string;
  display_name?: string;
}

// url-safe slug from a team name, with a short random suffix so two teams named
// "Analytics" don't collide on the UNIQUE(slug) constraint.
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'team'}-${slugSuffix()}`;
}

// Create a team and seat the founder as its owner. Returns the new Team, or null
// if there's no DB client (Clerk-only / unconfigured deployments).
export async function createTeam(
  name: string,
  ownerClerkId: string,
  ownerEmail: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<Team | null> {
  if (!client || !name.trim() || !ownerClerkId) return null;
  const { data, error } = await client
    .from('teams')
    .insert({ name: name.trim(), slug: slugify(name), created_by: ownerClerkId })
    .select('id, name, slug, plan, created_by')
    .single();
  if (error || !data) return null;
  const team = data as Team;
  // Seat the founder. Best-effort: a failure here leaves an orphan team the user
  // can retry into, but we don't roll back (no transactions over PostgREST).
  await client.from('team_members').insert({
    team_id: team.id,
    clerk_user_id: ownerClerkId,
    role: 'owner',
    email: ownerEmail,
    invited_by: ownerClerkId,
  });
  return team;
}

// The team a user belongs to (first membership wins — v1 is one-team-per-user).
export async function getTeamForUser(
  clerkUserId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<Team | null> {
  if (!client || !clerkUserId) return null;
  const { data: membership } = await client
    .from('team_members')
    .select('team_id')
    .eq('clerk_user_id', clerkUserId)
    .limit(1)
    .maybeSingle();
  const teamId = (membership as { team_id?: string } | null)?.team_id;
  if (!teamId) return null;
  const { data: team } = await client
    .from('teams')
    .select('id, name, slug, plan, created_by')
    .eq('id', teamId)
    .maybeSingle();
  return (team as Team) ?? null;
}

export async function getTeamMembers(
  teamId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<TeamMember[]> {
  if (!client || !teamId) return [];
  const { data } = await client
    .from('team_members')
    .select('id, team_id, clerk_user_id, role, email, display_name')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true });
  return (data as TeamMember[]) ?? [];
}

// Create an invitation and return its token. The accept link is
// {SITE_URL}/team/join?token={token}. Email delivery (Resend) is best-effort
// and wired separately — the token alone is sufficient to join.
export async function inviteMember(
  teamId: string,
  email: string,
  role: TeamRole,
  inviterClerkId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<string | null> {
  if (!client || !teamId || !email) return null;
  const token = nanoid(24);
  const { error } = await client.from('team_invitations').insert({
    team_id: teamId,
    email: email.trim().toLowerCase(),
    role,
    token,
    invited_by: inviterClerkId,
  });
  if (error) return null;
  return token;
}

// Accept an invitation: seat the user as a member of the invited team. Idempotent
// — re-accepting (or accepting when already a member) does not create a duplicate
// row, thanks to UNIQUE(team_id, clerk_user_id) + onConflict ignore.
export async function acceptInvitation(
  token: string,
  clerkUserId: string,
  email: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<{ teamId: string } | null> {
  if (!client || !token || !clerkUserId) return null;
  const { data: inv } = await client
    .from('team_invitations')
    .select('id, team_id, role, accepted_at, expires_at')
    .eq('token', token)
    .maybeSingle();
  const invitation = inv as
    | { id: string; team_id: string; role: TeamRole; accepted_at: string | null; expires_at: string | null }
    | null;
  if (!invitation) return null;
  if (invitation.expires_at && new Date(invitation.expires_at).getTime() < Date.now()) return null;

  await client
    .from('team_members')
    .upsert(
      {
        team_id: invitation.team_id,
        clerk_user_id: clerkUserId,
        role: invitation.role,
        email: email.trim().toLowerCase(),
        invited_by: null,
      },
      { onConflict: 'team_id,clerk_user_id', ignoreDuplicates: true },
    );

  await client
    .from('team_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invitation.id);

  return { teamId: invitation.team_id };
}

export async function removeMember(
  teamId: string,
  clerkUserId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<boolean> {
  if (!client || !teamId || !clerkUserId) return false;
  const { error } = await client
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('clerk_user_id', clerkUserId);
  return !error;
}

export async function updateMemberRole(
  teamId: string,
  clerkUserId: string,
  role: TeamRole,
  client: SupabaseClient | null = getSupabase(),
): Promise<boolean> {
  if (!client || !teamId || !clerkUserId) return false;
  const { error } = await client
    .from('team_members')
    .update({ role })
    .eq('team_id', teamId)
    .eq('clerk_user_id', clerkUserId);
  return !error;
}
