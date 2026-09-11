// Sprint 9 (compliance tier) — deterministic approval policy evaluation.
//
// A team's approval_policies rows say WHEN a validated query needs a second
// pair of eyes. This module answers that question as a pure function of
// (report, policies): no I/O, no clock, no AI. The same function runs in the
// editor (to show "approval required" before the user asks) and in
// POST /api/teams/approvals/request (to decide for real), so the two can
// never disagree.
//
// A policy matches when ANY of its conditions holds:
//   • min_score is set and report.riskScore < min_score
//   • any fired detector id is in detector_ids
//   • require_for_destructive and any destructive detector fired
// The FIRST matching active policy (ordered by created_at, then id — stable)
// is the one recorded on the request; its approver_roles decide who may
// resolve. Reasons from every matching policy are collected so the inbox can
// show the full picture.

import type { ValidationReport } from '../types/validation';

export const DESTRUCTIVE_DETECTORS = [
  'DESTRUCTIVE_DDL',
  'DESTRUCTIVE_TRUNCATE',
  'MISSING_WHERE_DESTRUCTIVE',
] as const;

export type ApproverRole = 'owner' | 'manager';

/** approval_policies columns the evaluator reads. */
export interface ApprovalPolicyRow {
  id: string;
  team_id: string;
  name: string;
  active: boolean;
  min_score: number | null;
  detector_ids: string[];
  require_for_destructive: boolean;
  approver_roles: ApproverRole[];
  created_at?: string;
}

export interface ApprovalDecision {
  required: boolean;
  /** Stable, de-duplicated. Forms: 'score<70' | '<DETECTOR_ID>' | 'destructive:<DETECTOR_ID>' */
  reasons: string[];
  /** First matching active policy, or null when nothing matched. */
  policyId: string | null;
  policyName: string | null;
  /** Roles allowed to resolve — from the matched policy; owner+manager when none matched. */
  approverRoles: ApproverRole[];
  /** Every policy that matched, in evaluation order (for the inbox / audit payload). */
  matchedPolicyIds: string[];
}

export const DEFAULT_APPROVER_ROLES: ApproverRole[] = ['owner', 'manager'];

/** Every detector id that fired, across severities, de-duplicated and sorted. */
export function firedDetectorIds(report: ValidationReport): string[] {
  const ids = new Set<string>();
  for (const i of [...report.errors, ...report.warnings, ...report.suggestions]) ids.add(i.id);
  return [...ids].sort();
}

/** Stable policy order: created_at asc, then id — so "first match" never depends on fetch order. */
export function orderPolicies(policies: readonly ApprovalPolicyRow[]): ApprovalPolicyRow[] {
  return [...policies].sort((a, b) => {
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Reasons a single policy produces for this report; empty when it does not match. */
export function policyReasons(report: ValidationReport, policy: ApprovalPolicyRow): string[] {
  const fired = firedDetectorIds(report);
  const reasons: string[] = [];
  if (policy.min_score !== null && policy.min_score !== undefined && report.riskScore < policy.min_score) {
    reasons.push(`score<${policy.min_score}`);
  }
  const watched = new Set((policy.detector_ids ?? []).map((d) => d.toUpperCase()));
  for (const id of fired) if (watched.has(id)) reasons.push(id);
  if (policy.require_for_destructive) {
    for (const id of fired) {
      if ((DESTRUCTIVE_DETECTORS as readonly string[]).includes(id)) reasons.push(`destructive:${id}`);
    }
  }
  return reasons;
}

export function evaluateApprovalPolicies(
  report: ValidationReport,
  policies: readonly ApprovalPolicyRow[],
): ApprovalDecision {
  const reasons = new Set<string>();
  const matched: ApprovalPolicyRow[] = [];
  for (const p of orderPolicies(policies)) {
    if (!p.active) continue;
    const r = policyReasons(report, p);
    if (r.length === 0) continue;
    matched.push(p);
    for (const x of r) reasons.add(x);
  }
  const first = matched[0];
  return {
    required: matched.length > 0,
    reasons: [...reasons],
    policyId: first?.id ?? null,
    policyName: first?.name ?? null,
    approverRoles: first && first.approver_roles.length > 0 ? [...first.approver_roles] : [...DEFAULT_APPROVER_ROLES],
    matchedPolicyIds: matched.map((p) => p.id),
  };
}

/** Who may resolve a request under a decision — never the requester (checked by the caller). */
export function canResolve(role: string, approverRoles: readonly ApproverRole[]): boolean {
  return (approverRoles as readonly string[]).includes(role);
}

/**
 * Does the client's report describe the same validation as the server's
 * re-run? Compares score and the fired detector ids — the two things an
 * approver relies on — and nothing cosmetic (timings, explanations).
 */
export function reportsAgree(client: ValidationReport, server: ValidationReport): boolean {
  if (client.riskScore !== server.riskScore) return false;
  const a = firedDetectorIds(client);
  const b = firedDetectorIds(server);
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
