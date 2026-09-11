import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../../_shared';
import { admin, callerId, isWriteRole, jsonRes, membershipOf, type Team, type TeamRole } from '../_shared';
import type { CustomRuleType } from '../../../../src/types/validation';

// Sprint 9 (compliance tier) — shared pieces for the custom-rules routes.
//
// Rules are team POLICY. Authoring is a Team+ capability (the seat is paid
// for); ENFORCEMENT in POST /api/validate is Business+ (see
// RULE_ENFORCEMENT_PLANS in functions/api/validate.ts). Every change lands on
// the chain as rule_created / rule_updated / rule_deleted.

export const RULE_AUTHORING_PLANS: ReadonlySet<string> = new Set(['team', 'business', 'enterprise']);
export const RULE_UPGRADE_URL = '#/pricing';

export interface RulesAccess {
  db: SupabaseClient;
  team: Team;
  role: TeamRole;
  clerkUserId: string;
}

export async function requireRulesAccess(request: Request, env: Env): Promise<RulesAccess | Response> {
  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);
  const db = admin(env);
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You are not a member of a team' }, 404);
  if (!RULE_AUTHORING_PLANS.has(membership.team.plan)) {
    return jsonRes({ error: 'Custom rules are a Team feature', plan: membership.team.plan, upgrade: RULE_UPGRADE_URL }, 402);
  }
  return { db, team: membership.team, role: membership.role, clerkUserId };
}

/** Owner or manager may write rules; member and auditor may only read. */
export function canWriteRules(role: string): boolean {
  return isWriteRole(role) && (role === 'owner' || role === 'manager');
}

// ── Rule shape validation (mirrors the engine's five types) ─────────────────

export const RULE_TYPES: Record<CustomRuleType, { fields: string[]; describe: string }> = {
  required_filter: { fields: ['table', 'column'], describe: 'Queries touching <table> must filter on <column>' },
  forbidden_table: { fields: ['table'], describe: 'Queries may not reference <table>' },
  required_join_condition: { fields: ['table', 'required_column'], describe: 'Joins to <table> must use <required_column>' },
  forbidden_pattern: { fields: ['pattern'], describe: 'SQL may not match the regex <pattern>' },
  required_column_qualification: { fields: ['table'], describe: 'Columns from <table> must be table-qualified' },
};

const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'suggestion']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.$]{0,127}$/;

export interface RuleInput {
  name: string;
  description: string | null;
  rule_type: CustomRuleType;
  config: Record<string, string>;
  severity: 'error' | 'warning' | 'suggestion';
  active: boolean;
}

/** Validate a create/update body. Returns the normalised rule or an error string. */
export function parseRuleInput(body: unknown, opts: { partial?: boolean } = {}): { rule: Partial<RuleInput> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: Partial<RuleInput> = {};

  if (b.name !== undefined || !opts.partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name is required' };
    if (b.name.length > 120) return { error: 'name must be 120 characters or fewer' };
    out.name = b.name.trim();
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== 'string') return { error: 'description must be a string' };
    out.description = typeof b.description === 'string' ? b.description.slice(0, 2000) : null;
  }
  if (b.rule_type !== undefined || !opts.partial) {
    if (typeof b.rule_type !== 'string' || !(b.rule_type in RULE_TYPES)) {
      return { error: `rule_type must be one of ${Object.keys(RULE_TYPES).join(', ')}` };
    }
    out.rule_type = b.rule_type as CustomRuleType;
  }
  if (b.severity !== undefined) {
    if (typeof b.severity !== 'string' || !SEVERITIES.has(b.severity)) return { error: 'severity must be error, warning or suggestion' };
    out.severity = b.severity as RuleInput['severity'];
  } else if (!opts.partial) {
    out.severity = 'warning';
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return { error: 'active must be a boolean' };
    out.active = b.active;
  } else if (!opts.partial) {
    out.active = true;
  }
  if (b.config !== undefined || !opts.partial) {
    if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) return { error: 'config must be an object' };
    const cfg = b.config as Record<string, unknown>;
    const type = out.rule_type;
    // On a partial update without rule_type we cannot check required fields — the
    // route re-validates against the stored type after merging.
    const normalised: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v !== 'string') return { error: `config.${k} must be a string` };
      normalised[k] = v.trim();
    }
    if (type) {
      const err = configErrorFor(type, normalised);
      if (err) return { error: err };
    }
    out.config = normalised;
  }
  return { rule: out };
}

export function configErrorFor(type: CustomRuleType, config: Record<string, string>): string | null {
  for (const f of RULE_TYPES[type].fields) {
    if (!config[f]) return `config.${f} is required for ${type}`;
    if (f === 'pattern') {
      try {
        new RegExp(config[f]);
      } catch {
        return 'config.pattern is not a valid regular expression';
      }
      if (config[f].length > 500) return 'config.pattern must be 500 characters or fewer';
    } else if (!IDENT_RE.test(config[f])) {
      return `config.${f} must be a SQL identifier (letters, digits, _ . $)`;
    }
  }
  return null;
}

export const RULE_COLUMNS =
  'id, team_id, name, description, rule_type, config, severity, active, created_by, created_by_clerk_user_id, created_at, updated_at, updated_by_clerk_user_id, last_event_seq';
