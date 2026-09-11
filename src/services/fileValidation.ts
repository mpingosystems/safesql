import { validateSQL } from './sqlValidator';
import { parseDDL } from './schemaParser';
import {
  mergeSchemas,
  parseDbtArtifacts,
  type DbtArtifactInput,
  type DbtContext,
} from './dbtArtifacts';
import type { CustomRule, SchemaDefinition, ValidationIssue, ValidationReport } from '../types/validation';
import type { PlanTier } from '../config/detectorTiers';

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
  // Sprint 8 (dbt) — parsed target/ artifacts. The derived schema is merged
  // UNDER schemaSql (an explicit DDL wins per table) and the context drives
  // UNAPPROVED_SOURCE / FINANCE_TAG_UNVALIDATED. currentModel is derived from
  // `filename` (basename without extension — dbt's model-name rule).
  dbtArtifacts?: DbtArtifactInput;
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
  // Sprint 5C — omit for the full detector set. The REST API passes the caller's
  // plan; the CLI and GitHub Action run the local engine and pass nothing.
  tier?: PlanTier,
  // Sprint 9 (compliance) — the caller's team custom rules. The REST API loads
  // them for Business+ teams; everything else passes nothing (unchanged).
  customRules?: CustomRule[],
): ValidationReport {
  const schema = schemaSql && schemaSql.trim() ? parseDDL(schemaSql, dialect) : undefined;
  return validateSQL({ sql, schema, dialect, tier, ...(customRules && customRules.length > 0 ? { customRules } : {}) });
}

// ── Sprint 8 (dbt) ───────────────────────────────────────────────────────────
// Parse the artifacts once and reuse across many files. The parser is pure, so
// this is only a name that says "do it once, then loop".
export interface DbtRunContext {
  schema: SchemaDefinition;
  context: DbtContext;
  warnings: string[];
}

export function prepareDbtContext(artifacts: DbtArtifactInput): DbtRunContext {
  return parseDbtArtifacts(artifacts);
}

// dbt's model-name rule: the SQL file's basename without its extension.
// `models/staging/stg_orders.sql` → `stg_orders`. Returns undefined for a
// name that is not a relation in the manifest, so an ad-hoc file passes no
// currentModel and the staging exemption cannot misfire.
export function modelNameFromFilename(filename: string | undefined, context: DbtContext): string | undefined {
  if (!filename) return undefined;
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  if (!stem) return undefined;
  const rel = context.models.get(stem.toLowerCase());
  return rel ? rel.relation : undefined;
}

export function validateSqlWithDbt(
  sql: string,
  dbt: DbtRunContext,
  schemaSql?: string,
  dialect: CliDialect = 'postgresql',
  tier?: PlanTier,
  currentModel?: string,
  customRules?: CustomRule[],
): ValidationReport {
  const userSchema = schemaSql && schemaSql.trim() ? parseDDL(schemaSql, dialect) : undefined;
  const schema = mergeSchemas(userSchema, dbt.schema);
  const context: DbtContext = currentModel ? { ...dbt.context, currentModel } : dbt.context;
  return validateSQL({ sql, schema, dialect, tier, dbtContext: context, ...(customRules && customRules.length > 0 ? { customRules } : {}) });
}

// Provenance summary for reports and API responses. Says what was loaded so a
// reader can tell "no finding" from "no context". Never the full context.
export interface DbtContextSummary {
  models: number;
  sources: number;
  sensitiveTagged: number;
  artifacts: { catalog: boolean; runResults: boolean };
}

export function summarizeDbtContext(ctx: DbtContext): DbtContextSummary {
  const uniqueModels = new Set([...ctx.models.values()].map((m) => m.uniqueId));
  const uniqueSources = new Set([...ctx.sources.values()].map((s) => s.uniqueId));
  const tagged = new Set<string>();
  for (const rel of [...ctx.models.values(), ...ctx.sources.values()]) {
    if (rel.tags.some((t) => ctx.sensitiveTags.includes(t))) tagged.add(rel.uniqueId);
  }
  return {
    models: uniqueModels.size,
    sources: uniqueSources.size,
    sensitiveTagged: tagged.size,
    artifacts: ctx.artifacts,
  };
}

// Two-line banner printed ahead of a text report when dbt context is active.
// "Finance-tagged" counts relations carrying ANY configured sensitive tag; the
// label is the product term, not the tag name.
export function dbtContextBanner(ctx: DbtContext): string {
  const s = summarizeDbtContext(ctx);
  return (
    'SafeSQL Guard — dbt manifest context loaded\n' +
    `Models: ${s.models} | Sources: ${s.sources} | Finance-tagged: ${s.sensitiveTagged}`
  );
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
  if (!opts.dbtArtifacts) {
    const report = validateSqlSource(opts.sql, opts.schemaSql, opts.dialect);
    const output = opts.json
      ? JSON.stringify(report, null, 2)
      : formatReportText(report, opts.filename ?? 'query.sql');
    return { report, output, exitCode: exitCodeFor(report, opts.failOnWarnings) };
  }

  // Sprint 8 (dbt): artifacts present — merge the derived schema under any
  // explicit DDL and hand the context to the engine.
  const dbt = prepareDbtContext(opts.dbtArtifacts);
  const currentModel = modelNameFromFilename(opts.filename, dbt.context);
  const report = validateSqlWithDbt(opts.sql, dbt, opts.schemaSql, opts.dialect, undefined, currentModel);
  const output = opts.json
    ? JSON.stringify({ ...report, dbtContext: { ...summarizeDbtContext(dbt.context), warnings: dbt.warnings } }, null, 2)
    : dbtContextBanner(dbt.context) + '\n' + formatReportText(report, opts.filename ?? 'query.sql');
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
