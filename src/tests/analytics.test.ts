import { describe, expect, it } from 'vitest';
import {
  computeOverview,
  computeScoreDistribution,
  computeSourceStats,
  computeTopIssueTypes,
  emptyAnalytics,
  type ValidationRecord,
} from '../services/analytics';

function rec(
  source: string,
  risk: number,
  errs: string[],
  warns: string[],
): ValidationRecord {
  return {
    source,
    risk_score: risk,
    error_count: errs.length,
    warning_count: warns.length,
    report: {
      errors: errs.map((id) => ({ id })),
      warnings: warns.map((id) => ({ id })),
    },
  };
}

const RECORDS: ValidationRecord[] = [
  // manual: 1 error, 1 warning-only, 2 clean → passRate 50%
  rec('manual', 25, ['CARTESIAN_JOIN'], []),
  rec('manual', 75, [], ['JOIN_MULTIPLICATION']),
  rec('manual', 100, [], []),
  rec('manual', 95, [], []),
  // cursor: 2 errors, 0 clean → passRate 0%
  rec('cursor', 25, ['HALLUCINATED_COLUMN'], ['JOIN_MULTIPLICATION']),
  rec('cursor', 30, ['CARTESIAN_JOIN'], []),
];

describe('computeSourceStats', () => {
  it('computes per-source pass rates (clean = no error and no warning)', () => {
    const stats = computeSourceStats(RECORDS);
    const manual = stats.find((s) => s.source === 'manual')!;
    expect(manual.validations).toBe(4);
    expect(manual.errors).toBe(1);
    expect(manual.warnings).toBe(1);
    expect(manual.passRate).toBe(50);
    const cursor = stats.find((s) => s.source === 'cursor')!;
    expect(cursor.validations).toBe(2);
    expect(cursor.passRate).toBe(0);
  });

  it('orders known sources before unknown', () => {
    const stats = computeSourceStats([...RECORDS, rec('weird', 100, [], [])]);
    expect(stats[0].source).toBe('manual');
    expect(stats[stats.length - 1].source).toBe('weird');
  });

  it('reads source from report.source when no top-level column', () => {
    const r: ValidationRecord = {
      risk_score: 100,
      error_count: 0,
      warning_count: 0,
      report: { source: 'copilot', errors: [], warnings: [] },
    };
    expect(computeSourceStats([r])[0].source).toBe('copilot');
  });
});

describe('computeTopIssueTypes', () => {
  it('returns issue types sorted by frequency with % of validations', () => {
    const top = computeTopIssueTypes(RECORDS, 5);
    expect(top[0].issueType).toBe('CARTESIAN_JOIN'); // appears twice
    expect(top[0].count).toBe(2);
    expect(top[0].pct).toBe(33); // 2 / 6 ≈ 33%
    expect(top.length).toBeLessThanOrEqual(5);
  });

  it('limits to top N', () => {
    expect(computeTopIssueTypes(RECORDS, 1).length).toBe(1);
  });
});

describe('computeScoreDistribution', () => {
  it('buckets scores into RISKY/REVIEW/CAUTION/SAFE', () => {
    const d = computeScoreDistribution(RECORDS);
    expect(d.RISKY).toBe(3); // 25, 25, 30
    expect(d.CAUTION).toBe(1); // 75
    expect(d.SAFE).toBe(2); // 100, 95
    expect(d.REVIEW).toBe(0);
  });
});

describe('computeOverview + emptyAnalytics (free gate)', () => {
  it('computes totals', () => {
    const o = computeOverview(RECORDS);
    expect(o.total).toBe(6);
    expect(o.errorsCaught).toBe(3);
    expect(o.cleanQueries).toBe(2);
  });

  it('free tier returns zeroed analytics', () => {
    const e = emptyAnalytics();
    expect(e.overview.total).toBe(0);
    expect(e.sources).toEqual([]);
    expect(e.topIssues).toEqual([]);
  });
});
