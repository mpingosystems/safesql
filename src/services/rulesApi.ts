// Sprint 9 (compliance tier) — browser client for /api/teams/rules.
// Rules are authored and managed through the API so every change is
// server-authorised and recorded on the team's chain. Never throws.

import type { CustomRule, CustomRuleType } from '../types/validation';
import { apiUrl } from '../config/api';
import { getClerkToken } from './supabaseClient';

export interface RulesApiDeps {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export interface TeamRule extends CustomRule {
  team_id: string;
  created_by_clerk_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  updated_by_clerk_user_id: string | null;
  last_event_seq: number | null;
}

export interface RulesList {
  team_id: string;
  team_plan: string;
  my_role: string;
  can_write: boolean;
  enforced_in_api: boolean;
  rows: TeamRule[];
}

export interface RuleDraft {
  name: string;
  description?: string | null;
  rule_type: CustomRuleType;
  config: Record<string, string>;
  severity?: 'error' | 'warning' | 'suggestion';
  active?: boolean;
}

type Fail = { ok: false; status: number; error: string };

async function call(path: string, init: RequestInit, deps: RulesApiDeps): Promise<Response | null> {
  const token = await (deps.getToken ?? getClerkToken)();
  if (!token) return null;
  return (deps.fetch ?? fetch)(apiUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function listRules(deps: RulesApiDeps = {}, opts: { includeInactive?: boolean } = {}): Promise<RulesList | Fail> {
  try {
    const res = await call(`/api/teams/rules${opts.includeInactive ? '?include_inactive=true' : ''}`, { method: 'GET' }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to view rules' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return body as unknown as RulesList;
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function createRule(draft: RuleDraft, deps: RulesApiDeps = {}): Promise<{ ok: true; rule: TeamRule; event_seq: number | null } | Fail> {
  try {
    const res = await call('/api/teams/rules', { method: 'POST', body: JSON.stringify(draft) }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to create rules' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return { ok: true, rule: body.rule as TeamRule, event_seq: typeof body.event_seq === 'number' ? body.event_seq : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function updateRule(id: string, patch: Partial<RuleDraft>, deps: RulesApiDeps = {}): Promise<{ ok: true; rule: TeamRule; event_seq: number | null } | Fail> {
  try {
    const res = await call(`/api/teams/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to edit rules' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return { ok: true, rule: body.rule as TeamRule, event_seq: typeof body.event_seq === 'number' ? body.event_seq : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function deleteRule(id: string, deps: RulesApiDeps = {}): Promise<{ ok: true; event_seq: number | null } | Fail> {
  try {
    const res = await call(`/api/teams/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to delete rules' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return { ok: true, event_seq: typeof body.event_seq === 'number' ? body.event_seq : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
