import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from './useAppUser';
import { listRules, type RulesList, type TeamRule } from '../services/rulesApi';
import type { CustomRule } from '../types/validation';

// Sprint 9 (compliance tier) — the caller's team custom rules, for the editor.
//
// Loaded once per signed-in session from GET /api/teams/rules (active only).
// The editor passes `rules` into validateSQL so a rule fires locally the same
// way it fires in POST /api/validate. Users with no team, or on a plan without
// rules, get an empty list and the editor behaves exactly as before.
//
// Note the difference from the API: the editor applies rules on any plan
// that can author them (Team+), so a Team-plan owner SEES their policy work;
// CI/API enforcement is Business+ (`enforcedInApi`), and the editor says so.

export interface UseCustomRulesResult {
  rules: CustomRule[];
  all: TeamRule[];
  enforcedInApi: boolean;
  canWrite: boolean;
  myRole: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCustomRules(): UseCustomRulesResult {
  const { appUser, isLoading: userLoading } = useAppUser();
  const [list, setList] = useState<RulesList | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!appUser || appUser.plan === 'free' || appUser.plan === 'pro') {
      setList(null);
      return;
    }
    setIsLoading(true);
    const res = await listRules({}, { includeInactive: true });
    if ('ok' in res && res.ok === false) {
      // 402/404 are expected for teams without the feature — not an error to show.
      setList(null);
      setError(res.status === 402 || res.status === 404 ? null : res.error);
    } else {
      setList(res as RulesList);
      setError(null);
    }
    setIsLoading(false);
  }, [appUser]);

  useEffect(() => {
    if (userLoading) return;
    void Promise.resolve().then(refresh);
  }, [userLoading, refresh]);

  const all = list?.rows ?? [];
  return {
    rules: all.filter((r) => r.active !== false),
    all,
    enforcedInApi: list?.enforced_in_api ?? false,
    canWrite: list?.can_write ?? false,
    myRole: list?.my_role ?? null,
    isLoading,
    error,
    refresh,
  };
}
