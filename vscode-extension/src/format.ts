import type { Issue, ValidationResult } from '@safesqlpro/sdk';

// Pure formatting helpers — deliberately free of any `vscode` import so they
// can be unit-tested with the repo's vitest run. Everything that touches the
// VS Code API lives in diagnostics.ts / statusBar.ts.

/** VS Code DiagnosticSeverity numeric values (Error 0, Warning 1, Information 2). */
export const SEVERITY_ERROR = 0;
export const SEVERITY_WARNING = 1;
export const SEVERITY_INFORMATION = 2;

export function severityValue(severity: Issue['severity']): number {
  if (severity === 'error') return SEVERITY_ERROR;
  if (severity === 'warning') return SEVERITY_WARNING;
  return SEVERITY_INFORMATION;
}

/**
 * Hover text for an issue:
 *
 *   [AGGREGATE_OVER_FANOUT_JOIN] JOIN on orders multiplies rows before SUM
 *   Fix: Pre-aggregate orders before joining
 *   Score impact: -35
 */
export function formatIssueMessage(issue: Issue): string {
  const lines = [`[${issue.issueType}] ${issue.message}`];
  if (issue.fix) lines.push(`Fix: ${issue.fix}`);
  if (issue.scoreImpact) lines.push(`Score impact: ${issue.scoreImpact}`);
  return lines.join('\n');
}

/**
 * Status bar label, e.g. "SafeSQL: 25 CRITICAL" — or, on a gated free key,
 * "SafeSQL: 25 CRITICAL (12/35)" so the narrowed coverage is visible at a
 * glance rather than only on hover. Paid keys keep the original label.
 */
export function statusBarText(result: ValidationResult, totalDetectors = 35): string {
  const base = `SafeSQL: ${result.score} ${result.verdict}`;
  const run = result.detectorsRun?.length;
  if (run !== undefined && run < totalDetectors) return `${base} (${run}/${totalDetectors})`;
  return base;
}

/** Status bar tooltip — issue counts by severity. */
export function statusBarTooltip(result: ValidationResult): string {
  const count = (s: Issue['severity']) => result.issues.filter((i) => i.severity === s).length;
  const lines = [
    `Score ${result.score}/100 — ${result.verdict}`,
    `${count('error')} error(s), ${count('warning')} warning(s), ${count('suggestion')} suggestion(s)`,
  ];
  // Sprint 5C — the extension reads the tier off the API response. Free keys run
  // a narrowed detector set, so say so rather than letting a thin result read as
  // a clean query.
  if (result.tier === 'free' && result.detectorsRun) {
    lines.push(`${result.detectorsRun.length} detectors active (free tier)`);
  }
  if (result.upgradePrompt) lines.push(result.upgradePrompt);
  lines.push('Click to re-validate');
  return lines.join('\n');
}

export interface Span {
  start: number;
  end: number;
}

const IDENTIFIER = /[A-Za-z0-9_$]/;

/**
 * Locate the span an issue should underline. Prefers the offending column, then
 * table, then clause keyword; falls back to the first line when nothing matches.
 * Matching is case-insensitive and respects identifier boundaries so `id` does
 * not match inside `customer_id`.
 */
export function locateIssue(text: string, issue: Issue): Span {
  const candidates = [issue.offendingColumn, issue.offendingTable, issue.offendingClause];
  for (const token of candidates) {
    if (!token) continue;
    const span = findToken(text, token);
    if (span) return span;
  }
  return { start: 0, end: Math.min(firstLineLength(text), text.length) };
}

function firstLineLength(text: string): number {
  const nl = text.indexOf('\n');
  return nl === -1 ? Math.max(text.length, 1) : Math.max(nl, 1);
}

/** First whole-token occurrence of `token`, or null. */
export function findToken(text: string, token: string): Span | null {
  if (!token) return null;
  const haystack = text.toLowerCase();
  const needle = token.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return null;
    const before = idx === 0 ? '' : haystack[idx - 1];
    const after = haystack[idx + needle.length] ?? '';
    const boundedLeft = before === '' || !IDENTIFIER.test(before);
    const boundedRight = after === '' || !IDENTIFIER.test(after);
    if (boundedLeft && boundedRight) return { start: idx, end: idx + needle.length };
    from = idx + 1;
  }
}
