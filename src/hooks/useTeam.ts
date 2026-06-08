import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from './useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { getTeamForUser, getTeamMembers, type Team, type TeamMember } from '../services/teams';

// Sprint 9 Part 1 — resolve the signed-in user's team + membership. Replaces the
// Sprint 8 "single-user stand-in" so Team-tier pages query by a real team id.
// Returns nulls (never throws) when Supabase/Clerk aren't configured or the user
// has no team yet — pages branch on `team === null` to show the setup CTA.
export interface UseTeamResult {
  team: Team | null;
  members: TeamMember[];
  role: TeamMember['role'] | null;
  isManager: boolean; // owner or manager
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useTeam(): UseTeamResult {
  const { appUser } = useAppUser();
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [role, setRole] = useState<TeamMember['role'] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const clerkId = appUser?.id ?? null;

  const refresh = useCallback(async () => {
    if (!clerkId || !isSupabaseConfigured) {
      setTeam(null);
      setMembers([]);
      setRole(null);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    setIsLoading(true);
    try {
      const t = await getTeamForUser(clerkId, supabase);
      setTeam(t);
      if (t) {
        const m = await getTeamMembers(t.id, supabase);
        setMembers(m);
        setRole(m.find((x) => x.clerk_user_id === clerkId)?.role ?? null);
      } else {
        setMembers([]);
        setRole(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [clerkId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    team,
    members,
    role,
    isManager: role === 'owner' || role === 'manager',
    isLoading,
    refresh,
  };
}
