import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { RULE_COLUMNS, canWriteRules, configErrorFor, parseRuleInput, requireRulesAccess, type RulesAccess } from './_shared';
import { appendAuditEvent, type AuditActorRole } from '../../../../src/services/auditChain';
import type { CustomRuleType } from '../../../../src/types/validation';

// Sprint 9 (compliance tier) — /api/teams/rules/:id
//   PATCH   edit name / description / config / severity / active (owner, manager)
//           → rule_updated on the chain with {from, to} for every changed field.
//           Setting active:false is the soft delete.
//   DELETE  hard delete (owner only) → rule_deleted on the chain carrying the
//           FULL rule, so the evidence retains what the rule was.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE = ['name', 'description', 'rule_type', 'config', 'severity', 'active'] as const;

export interface RuleItemDeps {
  access(request: Request): Promise<RulesAccess | Response>;
}

export function ruleIdFromPath(pathname: string): string | null {
  const m = /\/api\/teams\/rules\/([^/]+)\/?$/.exec(pathname);
  return m && UUID_RE.test(m[1]) ? m[1] : null;
}

async function loadRule(access: RulesAccess, id: string): Promise<Record<string, unknown> | null> {
  const { data } = await access.db.from('custom_rules').select(RULE_COLUMNS).eq('id', id).eq('team_id', access.team.id).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function handleRuleUpdate(request: Request, deps: RuleItemDeps): Promise<Response> {
  const id = ruleIdFromPath(new URL(request.url).pathname);
  if (!id) return jsonRes({ error: 'rule id must be a UUID' }, 400);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;
  if (!canWriteRules(role)) return jsonRes({ error: 'Only an owner or manager can edit rules' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseRuleInput(body, { partial: true });
  if ('error' in parsed) return jsonRes({ error: parsed.error }, 400);
  const patch = parsed.rule;
  if (Object.keys(patch).length === 0) return jsonRes({ error: 'nothing to update' }, 400);

  const existing = await loadRule(access, id);
  if (!existing) return jsonRes({ error: 'Rule not found' }, 404);

  // Re-check the config against the (possibly new) type after merging.
  const mergedType = (patch.rule_type ?? existing.rule_type) as CustomRuleType;
  const mergedConfig = (patch.config ?? existing.config) as Record<string, string>;
  const cfgErr = configErrorFor(mergedType, mergedConfig);
  if (cfgErr) return jsonRes({ error: cfgErr }, 400);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of EDITABLE) {
    if (patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(existing[k])) changes[k] = { from: existing[k], to: patch[k] };
  }
  if (Object.keys(changes).length === 0) return jsonRes({ rule: existing, event_seq: null, unchanged: true }, 200);

  const { data: updated, error } = await db
    .from('custom_rules')
    .update({ ...Object.fromEntries(Object.keys(changes).map((k) => [k, patch[k as keyof typeof patch]])), updated_by_clerk_user_id: clerkUserId })
    .eq('id', id)
    .eq('team_id', team.id)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error) return jsonRes({ error: `Could not update rule: ${error.message}` }, 500);
  if (!updated) return jsonRes({ error: 'Rule not found' }, 404);

  let seq: number | null = null;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'rule_updated',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: id,
      payload: { rule_id: id, name: updated.name, changes },
    });
    await db.from('custom_rules').update({ last_event_seq: seq }).eq('id', id);
  } catch (e) {
    console.warn('rule_updated chain event not recorded', (e as Error).message);
  }

  return jsonRes({ rule: { ...(updated as Record<string, unknown>), last_event_seq: seq ?? updated.last_event_seq }, changes, event_seq: seq }, 200);
}

export async function handleRuleDelete(request: Request, deps: RuleItemDeps): Promise<Response> {
  const id = ruleIdFromPath(new URL(request.url).pathname);
  if (!id) return jsonRes({ error: 'rule id must be a UUID' }, 400);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;
  if (role !== 'owner') return jsonRes({ error: 'Only the owner can delete a rule (managers can deactivate it instead)' }, 403);

  const existing = await loadRule(access, id);
  if (!existing) return jsonRes({ error: 'Rule not found' }, 404);

  // Chain FIRST: if the delete then fails, the evidence records an attempted
  // deletion of a rule that still exists — visible and harmless. The reverse
  // order could lose the rule's content forever.
  let seq: number;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'rule_deleted',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: id,
      payload: {
        rule_id: id,
        rule: {
          name: existing.name,
          description: existing.description,
          rule_type: existing.rule_type,
          config: existing.config,
          severity: existing.severity,
          active: existing.active,
          created_by: existing.created_by_clerk_user_id,
          created_at: existing.created_at,
        },
      },
    });
  } catch (e) {
    return jsonRes({ error: `Could not record deletion on the chain; rule not deleted: ${(e as Error).message}` }, 500);
  }

  const { error } = await db.from('custom_rules').delete().eq('id', id).eq('team_id', team.id);
  if (error) return jsonRes({ error: `Could not delete rule: ${error.message}`, event_seq: seq }, 500);
  return jsonRes({ ok: true, id, event_seq: seq }, 200);
}

export const onRequestOptions = preflight;

export const onRequestPatch = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleRuleUpdate(context.request, { access: (req) => requireRulesAccess(req, context.env) });

export const onRequestDelete = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleRuleDelete(context.request, { access: (req) => requireRulesAccess(req, context.env) });
