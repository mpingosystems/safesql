import type { Env } from '../../../_shared';
import { jsonRes, preflight } from '../_shared';
import { activePolicies, requireApprovalAccess, sha256Hex, userByClerkId, type ApprovalAccess } from './_shared';
import { validateSqlSource, type CliDialect } from '../../../../src/services/fileValidation';
import { evaluateApprovalPolicies, firedDetectorIds, reportsAgree } from '../../../../src/services/approvalPolicy';
import { appendAuditEvent, type AuditActorRole } from '../../../../src/services/auditChain';
import type { ValidationReport } from '../../../../src/types/validation';
import type { PlanTier } from '../../../../src/config/detectorTiers';

// Sprint 9 (compliance tier) — POST /api/teams/approvals/request
//
// The editor asks "does this validated query need approval, and if so open a
// request". The server does not trust the client's report: it re-runs the
// engine over the submitted SQL and refuses (409) when score or fired
// detector ids differ — so what gets approved is provably what was checked.
// The decision itself is evaluateApprovalPolicies(): deterministic, no AI.
//
// Written on every plan. Auditors are read-only and cannot request.

const MAX_BODY_BYTES = 256 * 1024;
const DIALECTS: ReadonlySet<string> = new Set(['postgresql', 'mysql', 'bigquery', 'snowflake']);
const PAID_PLANS: ReadonlySet<string> = new Set(['pro', 'team', 'business', 'enterprise']);

export interface ApprovalRequestDeps {
  access(request: Request): Promise<ApprovalAccess | Response>;
  /** The plan the caller's detector set runs under (users.plan). */
  callerPlan(clerkUserId: string, access: ApprovalAccess): Promise<string>;
}

interface Body {
  sql?: unknown;
  ddl?: unknown;
  dialect?: unknown;
  report?: unknown;
  requester_note?: unknown;
}

function isReport(v: unknown): v is ValidationReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.riskScore === 'number' && Array.isArray(r.errors) && Array.isArray(r.warnings) && Array.isArray(r.suggestions);
}

export async function handleApprovalRequest(request: Request, deps: ApprovalRequestDeps): Promise<Response> {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);
  const access = await deps.access(request);
  if (access instanceof Response) return access;
  const { db, team, role, clerkUserId } = access;
  if (role === 'auditor') return jsonRes({ error: 'Auditors are read-only and cannot request approval' }, 403);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return jsonRes({ error: 'Request body exceeds 256 KB' }, 413);
  let body: Body;
  try {
    body = JSON.parse(text) as Body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.sql !== 'string' || body.sql.trim() === '') return jsonRes({ error: 'sql is required' }, 400);
  if (!isReport(body.report)) return jsonRes({ error: 'report (ValidationReport) is required' }, 400);
  const dialect = typeof body.dialect === 'string' && DIALECTS.has(body.dialect) ? (body.dialect as CliDialect) : 'postgresql';
  const ddl = typeof body.ddl === 'string' && body.ddl.trim() ? body.ddl : undefined;
  const note = typeof body.requester_note === 'string' ? body.requester_note.slice(0, 2000) : undefined;

  // Re-validate server-side under the caller's own tier; the client's report
  // must describe the same result or nothing is recorded.
  const plan = await deps.callerPlan(clerkUserId, access);
  const tier: PlanTier = PAID_PLANS.has(plan) ? (plan as PlanTier) : 'free';
  const serverReport = validateSqlSource(body.sql, ddl, dialect, tier);
  if (!reportsAgree(body.report, serverReport)) {
    return jsonRes(
      {
        error: 'report does not match SQL — re-validate and try again',
        server: { riskScore: serverReport.riskScore, issueTypes: firedDetectorIds(serverReport) },
        client: { riskScore: body.report.riskScore, issueTypes: firedDetectorIds(body.report) },
      },
      409,
    );
  }

  const policies = await activePolicies(db, team.id);
  const decision = evaluateApprovalPolicies(serverReport, policies);
  if (!decision.required) return jsonRes({ required: false, reasons: [], policy_id: null }, 200);

  const sqlHash = await sha256Hex(body.sql);

  // Idempotency: an open request by this requester for this exact SQL is returned, not duplicated.
  const { data: existing } = await db
    .from('approval_requests')
    .select('id, trigger_reasons, policy_id, request_event_seq')
    .eq('team_id', team.id)
    .eq('requester_clerk_user_id', clerkUserId)
    .eq('status', 'pending')
    .eq('sql', body.sql)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return jsonRes(
      { required: true, id: existing.id, status: 'pending', duplicate: true, trigger_reasons: existing.trigger_reasons, policy_id: existing.policy_id, approver_roles: decision.approverRoles, request_event_seq: existing.request_event_seq },
      200,
    );
  }

  const requester = await userByClerkId(db, clerkUserId);
  const { data: created, error } = await db
    .from('approval_requests')
    .insert({
      team_id: team.id,
      requester_id: requester.id,
      requester_clerk_user_id: clerkUserId,
      sql: body.sql,
      ddl: ddl ?? null,
      dialect,
      validation_report: serverReport,
      risk_score: serverReport.riskScore,
      status: 'pending',
      requester_note: note ?? null,
      policy_id: decision.policyId,
      trigger_reasons: decision.reasons,
    })
    .select('id')
    .single();
  if (error || !created) return jsonRes({ error: `Could not create approval request: ${error?.message ?? 'no row'}` }, 500);

  // Chain: approval_requested (hash-only — the SQL itself lives on the request row).
  let seq: number | null = null;
  try {
    seq = await appendAuditEvent(db, {
      teamId: team.id,
      eventType: 'approval_requested',
      actor: clerkUserId,
      actorRole: role as AuditActorRole,
      subject: created.id as string,
      payload: {
        approval_id: created.id,
        sql_hash: sqlHash,
        dialect,
        risk_score: serverReport.riskScore,
        issue_types: firedDetectorIds(serverReport),
        trigger_reasons: decision.reasons,
        policy_id: decision.policyId,
        approver_roles: decision.approverRoles,
      },
    });
    await db.from('approval_requests').update({ request_event_seq: seq }).eq('id', created.id);
  } catch (e) {
    console.warn('approval_requested chain event not recorded', (e as Error).message);
  }

  return jsonRes(
    {
      required: true,
      id: created.id,
      status: 'pending',
      trigger_reasons: decision.reasons,
      policy_id: decision.policyId,
      policy_name: decision.policyName,
      approver_roles: decision.approverRoles,
      request_event_seq: seq,
    },
    201,
  );
}

export const onRequestOptions = preflight;

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleApprovalRequest(context.request, {
    access: (req) => requireApprovalAccess(req, context.env, { planGated: false }),
    async callerPlan(clerkUserId, access) {
      const { data } = await access.db.from('users').select('plan').eq('clerk_user_id', clerkUserId).maybeSingle();
      return (data?.plan as string | undefined) ?? 'free';
    },
  });
