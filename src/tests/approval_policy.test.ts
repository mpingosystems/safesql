import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVER_ROLES,
  canResolve,
  evaluateApprovalPolicies,
  firedDetectorIds,
  orderPolicies,
  policyReasons,
  reportsAgree,
  type ApprovalPolicyRow,
} from '../services/approvalPolicy';
import { validateSQL } from '../services/sqlValidator';
import { parseDbtArtifacts } from '../services/dbtArtifacts';
import manifestJson from '../services/__fixtures__/dbt/manifest.json';
import runResultsJson from '../services/__fixtures__/dbt/run_results.json';
import type { DbtManifest, DbtRunResults } from '../services/dbtArtifacts';

// Sprint 9 item 2 — deterministic approval policy evaluation. Mirrors the
// default policy seeded by 20260911020000_compliance_roles_and_approvals.sql.

const DEFAULT: ApprovalPolicyRow = {
  id: 'p-default', team_id: 't', name: 'Default — high-risk and governed sources', active: true,
  min_score: 70, detector_ids: ['UNAPPROVED_SOURCE', 'FINANCE_TAG_UNVALIDATED'], require_for_destructive: true,
  approver_roles: ['owner', 'manager'], created_at: '2026-09-11T00:00:00Z',
};
const pg = (sql: string) => validateSQL({ sql, dialect: 'postgresql' });

describe('evaluateApprovalPolicies', () => {
  it('clean query → not required, no policy, default approver roles', () => {
    const d = evaluateApprovalPolicies(pg('SELECT id FROM users WHERE id = 1'), [DEFAULT]);
    expect(d).toEqual({ required: false, reasons: [], policyId: null, policyName: null, approverRoles: DEFAULT_APPROVER_ROLES, matchedPolicyIds: [] });
  });

  it('score below min_score → required with a score reason', () => {
    const report = pg('SELECT a.id FROM a JOIN b'); // CARTESIAN_JOIN → hard error band
    expect(report.riskScore).toBeLessThan(70);
    const d = evaluateApprovalPolicies(report, [DEFAULT]);
    expect(d.required).toBe(true);
    expect(d.reasons).toContain('score<70');
    expect(d.policyId).toBe('p-default');
    expect(d.approverRoles).toEqual(['owner', 'manager']);
  });

  it('destructive SQL → required via the destructive rule even when nothing else matches', () => {
    const report = pg('DELETE FROM users');
    const d = evaluateApprovalPolicies(report, [{ ...DEFAULT, min_score: null, detector_ids: [] }]);
    expect(d.required).toBe(true);
    expect(d.reasons).toEqual(['destructive:MISSING_WHERE_DESTRUCTIVE']);
    const noDestructive = evaluateApprovalPolicies(report, [{ ...DEFAULT, min_score: null, detector_ids: [], require_for_destructive: false }]);
    expect(noDestructive.required).toBe(false);
  });

  it('watched detector fires → required by detector id (case-insensitive config)', () => {
    const { schema, context } = parseDbtArtifacts({ manifest: manifestJson as unknown as DbtManifest, runResults: runResultsJson as unknown as DbtRunResults });
    const report = validateSQL({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dialect: 'postgresql', schema, dbtContext: context });
    const d = evaluateApprovalPolicies(report, [{ ...DEFAULT, min_score: null, detector_ids: ['finance_tag_unvalidated'], require_for_destructive: false }]);
    expect(d).toMatchObject({ required: true, reasons: ['FINANCE_TAG_UNVALIDATED'], policyId: 'p-default' });
  });

  it('inactive policies are ignored; first active match wins; reasons from all matches are merged', () => {
    const report = pg('DELETE FROM users');
    const inactive: ApprovalPolicyRow = { ...DEFAULT, id: 'p-off', active: false, created_at: '2026-01-01T00:00:00Z' };
    const strict: ApprovalPolicyRow = { ...DEFAULT, id: 'p-strict', name: 'Strict', min_score: 95, detector_ids: [], require_for_destructive: false, approver_roles: ['owner'], created_at: '2026-02-01T00:00:00Z' };
    const d = evaluateApprovalPolicies(report, [DEFAULT, strict, inactive]);
    expect(d.policyId).toBe('p-strict'); // created earlier than DEFAULT
    expect(d.policyName).toBe('Strict');
    expect(d.approverRoles).toEqual(['owner']);
    expect(d.matchedPolicyIds).toEqual(['p-strict', 'p-default']);
    expect(d.reasons.sort()).toEqual(['destructive:MISSING_WHERE_DESTRUCTIVE', 'score<70', 'score<95'].sort());
  });

  it('is deterministic regardless of the order policies arrive in', () => {
    const report = pg('DELETE FROM users');
    const a: ApprovalPolicyRow = { ...DEFAULT, id: 'a', created_at: '2026-03-01T00:00:00Z' };
    const b: ApprovalPolicyRow = { ...DEFAULT, id: 'b', created_at: '2026-03-01T00:00:00Z' }; // same instant → id breaks the tie
    expect(evaluateApprovalPolicies(report, [b, a])).toEqual(evaluateApprovalPolicies(report, [a, b]));
    expect(orderPolicies([b, a]).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('empty policy list → never required', () => {
    expect(evaluateApprovalPolicies(pg('DELETE FROM users'), []).required).toBe(false);
  });
});

describe('helpers', () => {
  it('firedDetectorIds is sorted and unique across severities', () => {
    const report = pg('SELECT * FROM events e JOIN sessions s ON s.event_id = e.id');
    const ids = firedDetectorIds(report);
    expect(ids).toEqual([...new Set(ids)].sort());
    expect(ids.length).toBeGreaterThan(0);
  });

  it('policyReasons returns [] for a non-matching policy', () => {
    expect(policyReasons(pg('SELECT id FROM users WHERE id = 1'), DEFAULT)).toEqual([]);
  });

  it('canResolve follows the policy roles; member and auditor never resolve', () => {
    expect(canResolve('owner', ['owner', 'manager'])).toBe(true);
    expect(canResolve('manager', ['owner'])).toBe(false);
    expect(canResolve('member', ['owner', 'manager'])).toBe(false);
    expect(canResolve('auditor', ['owner', 'manager'])).toBe(false);
  });

  it('reportsAgree compares score + fired ids only, ignoring timings and explanations', () => {
    const a = pg('SELECT a.id FROM a JOIN b');
    const b = { ...pg('SELECT a.id FROM a JOIN b'), processingMs: 999, errors: a.errors.map((e) => ({ ...e, explanation: 'AI text' })) };
    expect(reportsAgree(a, b)).toBe(true);
    expect(reportsAgree(a, { ...a, riskScore: a.riskScore + 1 })).toBe(false);
    expect(reportsAgree(a, pg('SELECT id FROM users WHERE id = 1'))).toBe(false);
  });
});
