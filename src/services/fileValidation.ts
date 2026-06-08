import { validateSQL } from './sqlValidator';
import { parseDDL } from './schemaParser';
import type { ValidationIssue, ValidationReport } from '../types/validation';

// Shared engine for the CLI and the GitHub Action. Both are thin wrappers around
// this — the validator logic lives ONLY in sqlValidator.ts (no duplication).

export type CliDialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

export interface RunOptions {
  sql: string;
  schemaSql?: string;
  dialect?: CliDialect;
  json?: boolean;
  failOnWarnings?: boolean;
  filename?: string;
}

export interface RunResult {
  report: ValidationReport;
  output: string;
  exitCode: number;
}

export function validateSqlSource(
  sql: string,
  schemaSql?: string,
  dialect: CliDialect = 'postgresql',
): ValidationReport {
  const schema = schemaSql && schemaSql.trim() ? parseDDL(schemaSql, dialect) : undefined;
  return validateSQL({ sql, schema, dialect });
}

export function exitCodeFor(report: ValidationReport, failOnWarnings = false): number {
  if (report.errors.length > 0) return 1;
  if (failOnWarnings && report.warnings.length > 0) return 1;
  return 0;
}

export type Verdict = 'RISKY' | 'REVIEW' | 'SAFE';
export function verdictFor(score: number): Verdict {
  if (score < 50) return 'RISKY';
  if (score < 85) return 'REVIEW';
  return 'SAFE';
}

const BADGE: Record<ValidationIssue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARN',
  suggestion: 'SUGGEST',
};

// Plain-text (no ANSI) report — deterministic, so it's unit-testable. The CLI
// layers chalk colour on the verdict separately.
export function formatReportText(report: ValidationReport, filename: string): string {
  const lines: string[] = [];
  lines.push(`${filename} — score ${report.riskScore} [${verdictFor(report.riskScore)}]`);
  const all = [...report.errors, ...report.warnings, ...report.suggestions];
  for (const i of all) {
    lines.push(`  ${BADGE[i.severity]} ${i.id}: ${i.description}`);
    if (i.fix) lines.push(`     fix: ${i.fix}`);
  }
  lines.push(
    `${report.errors.length} error(s), ${report.warnings.length} warning(s), ${report.suggestions.length} suggestion(s)`,
  );
  return lines.join('\n');
}

export function runValidation(opts: RunOptions): RunResult {
  const report = validateSqlSource(opts.sql, opts.schemaSql, opts.dialect);
  const output = opts.json
    ? JSON.stringify(report, null, 2)
    : formatReportText(report, opts.filename ?? 'query.sql');
  return { report, output, exitCode: exitCodeFor(report, opts.failOnWarnings) };
}

// ── CI summary (GitHub Action $GITHUB_STEP_SUMMARY) ──────────────────────────
export interface FileResult {
  filename: string;
  report: ValidationReport;
}

export function summaryTable(results: FileResult[]): string {
  const header = '| File | Score | Errors | Warnings |\n|------|-------|--------|----------|';
  const rows = results.map(
    (r) =>
      `| ${r.filename} | ${r.report.riskScore} | ${r.report.errors.length} | ${r.report.warnings.length} |`,
  );
  return [header, ...rows].join('\n');
}

// Aggregate exit decision across many files (used by the Action).
export function anyFailing(results: FileResult[], failOnWarnings = false): boolean {
  return results.some((r) => exitCodeFor(r.report, failOnWarnings) !== 0);
}
