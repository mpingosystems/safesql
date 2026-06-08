import { describe, expect, it } from 'vitest';
import {
  computeMemberLeaderboard,
  computeRiskyQueryLog,
  computeTeamTopIssues,
  emptyTeamAnalytics,
  type TeamValidationRecord,
} from '../services/analytics';

function rec(member: string, risk: number, errs: string[], warns: string[], created = '2026-06-01'): TeamValidationRecord {
  return {
    member,
    risk_score: risk,
    error_count: errs.length,
    warning_count: warns.length,
    created_at: created,
    report: { errors: errs.map((id) => ({ id })), warnings: warns.map((id) => ({ id })) },
  };
}

const TEAM: TeamValidationRecord[] = [
  rec('alice', 90, [], [], '2026-06-05'),
  rec('alice', 100, [], [], '2026-06-06'),
  rec('alice', 80, [], ['JOIN_MULTIPLICATION'], '2026-06-07'),
  rec('bob', 25, ['CARTESIAN_JOIN'], [], '2026-06-05'),
  rec('bob', 30, ['CARTESIAN_JOIN'], ['JOIN_MULTIPLICATION'], '2026-06-06'),
];

describe('computeMemberLeaderboard', () => {
  it('sorts members by pass rate desc', () => {
    const lb = computeMemberLeaderboard(TEAM);
    expect(lb[0].member).toBe('alice'); // 2/3 clean ≈ 67%
    expect(lb[1].member).toBe('bob'); // 0% pass
    expect(lb[0].passRate).toBeGreaterThan(lb[1].passRate);
    expect(lb[1].passRate).toBe(0);
  });
});

describe('computeTeamTopIssues', () => {
  it('ranks issue types by frequency across the team', () => {
    const top = computeTeamTopIssues(TEAM);
    expect(top[0].issueType).toBe('CARTESIAN_JOIN'); // appears twice
    expect(top[0].count).toBe(2);
  });
});

describe('computeRiskyQueryLog', () => {
  it('returns only score < 70, newest first, with author + top issue', () => {
    const log = computeRiskyQueryLog(TEAM);
    expect(log.length).toBe(2); // bob's two
    expect(log.every((q) => q.score < 70)).toBe(true);
    expect(log[0].createdAt! >= log[1].createdAt!).toBe(true);
    expect(log[0].member).toBe('bob');
    expect(log[0].topIssue).toBe('CARTESIAN_JOIN');
  });
});

describe('team gate', () => {
  it('non-team caller gets empty + upgradeRequired flag', () => {
    const e = emptyTeamAnalytics();
    expect(e.upgradeRequired).toBe(true);
    expect(e.leaderboard).toEqual([]);
    expect(e.overview.total).toBe(0);
  });
});
