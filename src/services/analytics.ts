// Sprint 7 Part 2 — LLM source analytics. Pure compute functions over stored
// validation rows; the page (Analytics.tsx) fetches the rows from Supabase and
// renders these. Kept pure + dependency-free so they're fully unit-testable.

import type { SqlSource } from '../types/validation';

// A stored validation row (subset of the `validations` table). `source` lives
// inside the persisted report JSON (PQ1), with an optional top-level column.
export interface ValidationRecord {
  source?: string | null;
  risk_score: number;
  error_count: number;
  warning_count: number;
  report?: {
    errors?: { id: string }[];
    warnings?: { id: string }[];
    suggestions?: { id: string }[];
    source?: SqlSource;
  } | null;
  created_at?: string;
}

const SOURCE_ORDER = ['manual', 'cursor', 'copilot', 'chatgpt', 'unknown'] as const;
const SOURCE_LABEL: Record<string, string> = {
  manual: 'Hand-written',
  cursor: 'Cursor',
  copilot: 'Copilot',
  chatgpt: 'ChatGPT',
  unknown: 'Unknown',
};

function sourceOf(r: ValidationRecord): string {
  return r.source ?? r.report?.source ?? 'unknown';
}

export interface SourceStat {
  source: string;
  label: string;
  validations: number;
  errors: number; // # of validations that had ≥1 error
  warnings: number; // # of validations that had warnings but no errors
  passRate: number; // % with neither error nor warning
}

// Partition each source's validations into error / warning-only / clean so the
// three columns sum to the total (matches the brief's example table).
export function computeSourceStats(records: ValidationRecord[]): SourceStat[] {
  const bySource = new Map<string, ValidationRecord[]>();
  for (const r of records) {
    const s = sourceOf(r);
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s)!.push(r);
  }
  const stats: SourceStat[] = [];
  for (const [source, rows] of bySource) {
    const total = rows.length;
    const errors = rows.filter((r) => r.error_count > 0).length;
    const warnings = rows.filter((r) => r.error_count === 0 && r.warning_count > 0).length;
    const clean = total - errors - warnings;
    stats.push({
      source,
      label: SOURCE_LABEL[source] ?? source,
      validations: total,
      errors,
      warnings,
      passRate: total === 0 ? 0 : Math.round((clean / total) * 100),
    });
  }
  // Stable ordering: known sources first (manual→unknown), then by volume.
  return stats.sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a.source as (typeof SOURCE_ORDER)[number]);
    const ib = SOURCE_ORDER.indexOf(b.source as (typeof SOURCE_ORDER)[number]);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return b.validations - a.validations;
  });
}

export interface IssueTypeCount {
  issueType: string;
  count: number;
  pct: number; // % of total validations
}

export function computeTopIssueTypes(records: ValidationRecord[], top = 5): IssueTypeCount[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const issues = [...(r.report?.errors ?? []), ...(r.report?.warnings ?? [])];
    for (const i of issues) counts.set(i.id, (counts.get(i.id) ?? 0) + 1);
  }
  const total = records.length || 1;
  return [...counts.entries()]
    .map(([issueType, count]) => ({ issueType, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count || a.issueType.localeCompare(b.issueType))
    .slice(0, top);
}

export interface ScoreDistribution {
  RISKY: number; // 0-40
  REVIEW: number; // 41-69
  CAUTION: number; // 70-84
  SAFE: number; // 85-100
}

export function computeScoreDistribution(records: ValidationRecord[]): ScoreDistribution {
  const dist: ScoreDistribution = { RISKY: 0, REVIEW: 0, CAUTION: 0, SAFE: 0 };
  for (const r of records) {
    const s = r.risk_score;
    if (s <= 40) dist.RISKY++;
    else if (s <= 69) dist.REVIEW++;
    else if (s <= 84) dist.CAUTION++;
    else dist.SAFE++;
  }
  return dist;
}

export interface Overview {
  total: number;
  errorsCaught: number; // # validations with ≥1 error
  warningsCaught: number; // # validations with ≥1 warning
  cleanQueries: number; // # with no errors and no warnings
}

export function computeOverview(records: ValidationRecord[]): Overview {
  return {
    total: records.length,
    errorsCaught: records.filter((r) => r.error_count > 0).length,
    warningsCaught: records.filter((r) => r.warning_count > 0).length,
    cleanQueries: records.filter((r) => r.error_count === 0 && r.warning_count === 0).length,
  };
}

// Free-tier mock so the page can render its structure (blurred) without leaking
// real data. isProUser=false → return zeroed/empty analytics.
export function emptyAnalytics(): {
  overview: Overview;
  sources: SourceStat[];
  topIssues: IssueTypeCount[];
  distribution: ScoreDistribution;
} {
  return {
    overview: { total: 0, errorsCaught: 0, warningsCaught: 0, cleanQueries: 0 },
    sources: [],
    topIssues: [],
    distribution: { RISKY: 0, REVIEW: 0, CAUTION: 0, SAFE: 0 },
  };
}

// ── Sprint 8 Part 2 — team analytics ─────────────────────────────────────────
export interface TeamValidationRecord extends ValidationRecord {
  member: string; // author email or name
  permalink_id?: string | null;
}

export interface MemberStat {
  member: string;
  validations: number;
  passRate: number; // % with no error and no warning
  avgScore: number;
}

// Members ranked by pass rate (then avg score) — the leaderboard / coaching view.
export function computeMemberLeaderboard(records: TeamValidationRecord[]): MemberStat[] {
  const byMember = new Map<string, TeamValidationRecord[]>();
  for (const r of records) {
    if (!byMember.has(r.member)) byMember.set(r.member, []);
    byMember.get(r.member)!.push(r);
  }
  const out: MemberStat[] = [];
  for (const [member, rows] of byMember) {
    const total = rows.length;
    const clean = rows.filter((r) => r.error_count === 0 && r.warning_count === 0).length;
    out.push({
      member,
      validations: total,
      passRate: total ? Math.round((clean / total) * 100) : 0,
      avgScore: total ? Math.round(rows.reduce((s, r) => s + (r.risk_score ?? 0), 0) / total) : 0,
    });
  }
  return out.sort((a, b) => b.passRate - a.passRate || b.avgScore - a.avgScore);
}

// Issue types ranked across the whole team (reuses the per-user counter).
export function computeTeamTopIssues(records: TeamValidationRecord[], top = 10): IssueTypeCount[] {
  return computeTopIssueTypes(records, top);
}

export interface RiskyQuery {
  member: string;
  score: number;
  topIssue: string;
  permalinkId?: string | null;
  createdAt?: string;
}

// Recent high-risk queries (score < 70), newest first.
export function computeRiskyQueryLog(records: TeamValidationRecord[], limit = 20): RiskyQuery[] {
  return records
    .filter((r) => r.risk_score < 70)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, limit)
    .map((r) => {
      const issues = [...(r.report?.errors ?? []), ...(r.report?.warnings ?? [])];
      return {
        member: r.member,
        score: r.risk_score,
        topIssue: issues[0]?.id ?? '—',
        permalinkId: r.permalink_id ?? null,
        createdAt: r.created_at,
      };
    });
}

export interface TeamOverview {
  total: number;
  avgScore: number;
  mostCommonError: string | null;
  lowestPassRateMember: string | null;
}

export function computeTeamOverview(records: TeamValidationRecord[]): TeamOverview {
  const total = records.length;
  const avgScore = total ? Math.round(records.reduce((s, r) => s + (r.risk_score ?? 0), 0) / total) : 0;
  const mostCommonError = computeTeamTopIssues(records, 1)[0]?.issueType ?? null;
  const leaderboard = computeMemberLeaderboard(records);
  const lowestPassRateMember = leaderboard.length ? leaderboard[leaderboard.length - 1].member : null;
  return { total, avgScore, mostCommonError, lowestPassRateMember };
}

// Team-gate: non-team caller gets an empty result flagged for the upgrade prompt.
export function emptyTeamAnalytics(): {
  overview: TeamOverview;
  leaderboard: MemberStat[];
  topIssues: IssueTypeCount[];
  risky: RiskyQuery[];
  upgradeRequired: true;
} {
  return {
    overview: { total: 0, avgScore: 0, mostCommonError: null, lowestPassRateMember: null },
    leaderboard: [],
    topIssues: [],
    risky: [],
    upgradeRequired: true,
  };
}
