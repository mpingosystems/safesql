import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { RULE_COLUMNS, canWriteRules, parseRuleInput, requireRulesAccess, type RulesAccess } from './_shared';
import { appendAuditEvent, type AuditActorRole } from '../../../../src/services/auditChain';

// Sprint 9 (compliance tier) — /api/teams/rules
//   GET   list the team's rules (every seated role, auditor included)
//   POST  create a rule (owner / manager) → rule_created on the chain

export interface RulesDeps {
  access(request: Request): Promise<RulesAccess | Response>;
}

export async function handleRulesList(request: Request, deps: RulesDeps): Promise<Response> {
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role } = access;
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('include_inactive') === 'true';

  let q = db.from('custom_rules').select(RULE_COLUMNS).eq('team_id', team.id).order('created_at', { ascending: true });
  if (!includeInactive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return jsonRes({ error: `Could not read rules: ${error.message}` }, 500);

  // Creator emails for display.
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const clerkIds = [...new Set(rows.map((r) => r.created_by_clerk_user_id).filter((x): x is string => typeof x === 'string'))];
  const emails = new Map<string, string>();
  if (clerkIds.length > 0) {
    const { data: members } = await db.from('team_members').select('clerk_user_id, email').eq('team_id', team.id).in('clerk_user_id', clerkIds);
    for (const m of (members ?? []) as Array<{ clerk_user_id: string; email: string }>) emails.set(m.clerk_user_id, m.email);
  }

  return jsonRes(
    {
      team_id: team.id,
      team_plan: team.plan,
      my_role: role,
      can_write: canWriteRules(role),
      // Rules are enforced by the API only on Business+; tell the UI so it can say so.
      enforced_in_api: team.plan === 'business' || team.plan === 'enterprise',
      rows: rows.map((r) => ({ ...r, created_by_email: emails.get(String(r.created_by_clerk_user_id)) ?? null })),
    },
    200,
  );
}

export async function handleRuleCreate(request: Request, deps: RulesDeps): Promise<Response> {
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;
  if (!canWriteRules(role)) return jsonRes({ error: 'Only an owner or manager can create rules' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseRuleInput(body);
  if ('error' in parsed) return jsonRes({ error: parsed.error }, 400);
  const rule = parsed.rule;

  const { data: creator } = await db.from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  const { data: created, error } = await db
    .from('custom_rules')
    .insert({
      team_id: team.id,
      name: rule.name,
      description: rule.description ?? null,
      rule_type: rule.rule_type,
      config: rule.config,
      severity: rule.severity,
      active: rule.active,
      created_by: (creator?.id as string | undefined) ?? null,
      created_by_clerk_user_id: clerkUserId,
      updated_by_clerk_user_id: clerkUserId,
    })
    .select(RULE_COLUMNS)
    .single();
  if (error || !created) return jsonRes({ error: `Could not create rule: ${error?.message ?? 'no row'}` }, 500);

  let seq: number | null = null;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'rule_created',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: created.id as string,
      payload: { rule_id: created.id, name: rule.name, rule_type: rule.rule_type, config: rule.config, severity: rule.severity, active: rule.active },
    });
    await db.from('custom_rules').update({ last_event_seq: seq }).eq('id', created.id);
  } catch (e) {
    console.warn('rule_created chain event not recorded', (e as Error).message);
  }

  return jsonRes({ rule: { ...(created as Record<string, unknown>), last_event_seq: seq }, event_seq: seq }, 201);
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleRulesList(context.request, { access: (req) => requireRulesAccess(req, context.env) });

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleRuleCreate(context.request, { access: (req) => requireRulesAccess(req, context.env) });
