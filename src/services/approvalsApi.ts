// Sprint 9 (compliance tier) — browser client for the approvals API.
//
// Replaces the direct-Supabase path in approvals.ts for the editor and the
// inbox: the server re-validates the SQL, evaluates the team's policies,
// enforces separation of duties and writes the chain events. The browser only
// asks and displays. Injectable fetch/token for tests.

import type { ValidationReport } from '../types/validation';
import { apiUrl } from '../config/api';
import { getClerkToken } from './supabaseClient';
import type { ApproverRole } from './approvalPolicy';

export interface ApprovalsApiDeps {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export interface RequestApprovalInput {
  sql: string;
  ddl?: string;
  dialect?: string;
  report: ValidationReport;
  note?: string;
}

export type RequestApprovalResult =
  | { ok: true; required: false }
  | { ok: true; required: true; id: string; duplicate?: boolean; trigger_reasons: string[]; approver_roles: ApproverRole[]; policy_name?: string | null }
  | { ok: false; status: number; error: string; server?: { riskScore: number; issueTypes: string[] } };

export interface ApprovalInboxRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  requester_clerk_user_id: string | null;
  requester_email: string | null;
  approver_clerk_user_id: string | null;
  approver_email: string | null;
  approver_role: string | null;
  approver_roles: ApproverRole[];
  can_resolve_this: boolean;
  sql: string;
  ddl: string | null;
  dialect: string;
  risk_score: number;
  validation_report: ValidationReport | null;
  trigger_reasons: string[];
  policy_id: string | null;
  requester_note: string | null;
  approver_note: string | null;
  created_at: string;
  resolved_at: string | null;
  request_event_seq: number | null;
  resolution_event_seq: number | null;
}

export interface ApprovalInbox {
  team_id: string;
  my_role: string;
  can_resolve: boolean;
  rows: ApprovalInboxRow[];
  next_cursor: string | null;
}

async function call(path: string, init: RequestInit, deps: ApprovalsApiDeps): Promise<Response | null> {
  const token = await (deps.getToken ?? getClerkToken)();
  if (!token) return null;
  return (deps.fetch ?? fetch)(apiUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export async function requestApproval(input: RequestApprovalInput, deps: ApprovalsApiDeps = {}): Promise<RequestApprovalResult> {
  try {
    const res = await call('/api/teams/approvals/request', {
      method: 'POST',
      body: JSON.stringify({ sql: input.sql, ddl: input.ddl, dialect: input.dialect, report: input.report, requester_note: input.note }),
    }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to request approval' };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 200 && body.required === false) return { ok: true, required: false };
    if (res.status === 201 || (res.status === 200 && body.required === true)) {
      return {
        ok: true, required: true, id: String(body.id), duplicate: body.duplicate === true,
        trigger_reasons: Array.isArray(body.trigger_reasons) ? (body.trigger_reasons as string[]) : [],
        approver_roles: Array.isArray(body.approver_roles) ? (body.approver_roles as ApproverRole[]) : ['owner', 'manager'],
        policy_name: (body.policy_name as string | null | undefined) ?? null,
      };
    }
    const server = body.server && typeof body.server === 'object' ? (body.server as { riskScore: number; issueTypes: string[] }) : undefined;
    return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`), ...(server ? { server } : {}) };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function listApprovals(
  status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
  deps: ApprovalsApiDeps = {},
  opts: { limit?: number; cursor?: string } = {},
): Promise<ApprovalInbox | { error: string; status: number }> {
  try {
    const qs = new URLSearchParams({ status, ...(opts.limit ? { limit: String(opts.limit) } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) });
    const res = await call(`/api/teams/approvals?${qs}`, { method: 'GET' }, deps);
    if (!res) return { error: 'Sign in to view approvals', status: 401 };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { error: String(body.error ?? `HTTP ${res.status}`), status: res.status };
    return body as unknown as ApprovalInbox;
  } catch (e) {
    return { error: (e as Error).message, status: 0 };
  }
}

export async function resolveApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note: string | undefined,
  deps: ApprovalsApiDeps = {},
): Promise<{ ok: true; resolution_event_seq: number | null } | { ok: false; status: number; error: string }> {
  try {
    const res = await call(`/api/teams/approvals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision, note: note?.trim() || undefined }),
    }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to resolve approvals' };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return { ok: true, resolution_event_seq: typeof body.resolution_event_seq === 'number' ? body.resolution_event_seq : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
