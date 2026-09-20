import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  modelNameFromFilename,
  prepareDbtContext,
  summarizeDbtContext,
  validateSqlSource,
  validateSqlWithDbt,
  verdictFor,
  type CliDialect,
  type DbtRunContext,
} from '../src/services/fileValidation';
import type { DbtArtifactInput } from '../src/services/dbtArtifacts';
import { locateIssue } from '../src/services/issueLocator';
import { DETECTOR_VERSION } from '../src/config/detectorVersion';
import type { ValidationIssue, ValidationReport } from '../src/types/validation';

// Sprint 9.5A-pre — batch scan: the SQL Health Check engine.
//
// `safesql scan --dir <path>` walks a directory of .sql files, validates each
// one with the SAME engine the single-file command uses (validateSqlSource /
// validateSqlWithDbt — nothing duplicated, nothing changed), and folds the
// per-file reports into one consolidated deliverable: Markdown, JSON or text.
//
// Everything in this module is testable without a terminal: file discovery
// takes a directory, the scan takes a file list + injectable fetch/progress/
// delay, and the formatters are pure functions of a BatchScanResult.

// ── Types ───────────────────────────────────────────────────────────────────

/** Report vocabulary. The engine's error/warning/suggestion map 1:1 onto these. */
export type ReportSeverity = 'Critical' | 'Risky' | 'Review';

export const SEVERITY_OF: Record<ValidationIssue['severity'], ReportSeverity> = {
  error: 'Critical',
  warning: 'Risky',
  suggestion: 'Review',
};

const SEVERITY_RANK: Record<ReportSeverity, number> = { Critical: 0, Risky: 1, Review: 2 };

export interface BatchIssue {
  detector: string;
  severity: ReportSeverity;
  message: string;
  fix: string;
  line: number | null;
}

export interface BatchFileResult {
  path: string;
  score: number;
  issues: BatchIssue[];
}

export interface BatchDetectorRow {
  detector: string;
  severity: ReportSeverity;
  fire_count: number;
  files: string[];
}

/** Exactly the `--format json` document (Feature 3). Nothing extra. */
export interface BatchScanResult {
  meta: {
    scanned_dir: string;
    date: string;
    files_scanned: number;
    detector_version: string;
    dialect: string;
    dbt_context: boolean;
    scan_duration_ms: number;
  };
  summary: {
    files_with_issues: number;
    files_clean: number;
    critical_count: number;
    risky_count: number;
    review_count: number;
    avg_score: number;
  };
  by_detector: BatchDetectorRow[];
  files: BatchFileResult[];
  bundle_hash: string | null;
}

/** One Top-10 entry: an issue with its file and score attached. */
export interface RankedFinding extends BatchIssue {
  path: string;
  score: number;
}

export interface BatchScanOptions {
  /** Directory that was scanned — recorded in meta and used to relativise paths. */
  dir: string;
  dialect?: CliDialect;
  /** Files scoring >= threshold are counted but reported issue-free (default 100 = report everything). */
  threshold?: number;
  dbtArtifacts?: DbtArtifactInput;
  /** SafeSQL Pro API key. When present every file goes through POST /api/validate. */
  apiKey?: string;
  apiBase?: string;
  /** Milliseconds to wait between API calls (default 10). Ignored without apiKey. */
  apiDelayMs?: number;
  /** Progress + warning sink. Defaults to process.stderr. Never stdout. */
  progress?: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wall-clock stamp for meta.date (defaults to new Date()). */
  date?: () => Date;
  /** Read a file's contents — injectable so tests can feed SQL without disk. */
  readFile?: (absolutePath: string) => string;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_API_BASE = 'https://safesqlpro.dev';
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'target']);
export const API_DELAY_MS = 10;
export const TOP_FINDINGS = 10;
export const CONTACT_EMAIL = 'eddy@mpingo.ai';
export const NO_BUNDLE_NOTE =
  'Signed evidence bundle not generated. Add --api-key to enable cryptographic signing.';
export const SIGN_NEEDS_KEY_WARNING =
  'Evidence bundle requires an API key. Get one at safesqlpro.dev/#/settings';

// ── File discovery ──────────────────────────────────────────────────────────

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. No deps. */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern without a slash matches a basename anywhere (like `*.test.sql`).
  const anchored = p.includes('/') ? `^${re}$` : `(?:^|/)${re}$`;
  return new RegExp(anchored, 'i');
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Recursively find .sql files under `dir`. Skips node_modules/, .git/ and
 * target/ (dbt compiled output) at any depth. Returns paths RELATIVE to
 * `dir`, POSIX-separated, sorted — so two scans of the same tree produce
 * identical reports whatever the OS.
 */
export function discoverSqlFiles(dir: string, exclude?: string): string[] {
  const root = resolve(dir);
  const excludeRe = exclude ? globToRegExp(exclude) : null;
  const out: string[] = [];
  const walk = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(abs, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.sql$/i.test(e.name)) {
        const rel = toPosix(relative(root, full));
        if (excludeRe && excludeRe.test(rel)) continue;
        out.push(rel);
      }
    }
  };
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── Per-file validation ─────────────────────────────────────────────────────

function issueLine(sql: string, issue: ValidationIssue): number | null {
  if (typeof issue.lineStart === 'number') return issue.lineStart;
  const range = locateIssue(sql, issue);
  return range ? range.startLineNumber : null;
}

function toBatchIssue(sql: string, issue: ValidationIssue): BatchIssue {
  return {
    detector: issue.id,
    severity: SEVERITY_OF[issue.severity] ?? 'Review',
    message: issue.description,
    fix: issue.fix ?? '',
    line: issueLine(sql, issue),
  };
}

function allIssues(report: ValidationReport): ValidationIssue[] {
  return [...report.errors, ...report.warnings, ...report.suggestions];
}

/** Turn a ValidationReport into the report row for one file. */
export function fileResultOf(path: string, sql: string, report: ValidationReport, threshold = 100): BatchFileResult {
  const issues = report.riskScore >= threshold ? [] : allIssues(report).map((i) => toBatchIssue(sql, i));
  return { path, score: report.riskScore, issues };
}

function localValidate(sql: string, path: string, opts: BatchScanOptions, dbt?: DbtRunContext): ValidationReport {
  const dialect = opts.dialect ?? 'postgresql';
  if (!dbt) return validateSqlSource(sql, undefined, dialect);
  return validateSqlWithDbt(sql, dbt, undefined, dialect, undefined, modelNameFromFilename(path, dbt.context));
}

// POST /api/validate returns the ValidationReport spread at the top level
// (plus tier / detectorVersion / customRulesApplied). We only keep the report
// fields the local engine would have produced, so both paths aggregate alike.
async function apiValidate(
  sql: string,
  path: string,
  opts: BatchScanOptions,
  dbt?: DbtRunContext,
): Promise<ValidationReport> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const body: Record<string, unknown> = { sql, dialect: opts.dialect ?? 'postgresql' };
  if (opts.dbtArtifacts && dbt) {
    body.dbt = { ...opts.dbtArtifacts, currentModel: modelNameFromFilename(path, dbt.context) };
  }
  const res = await doFetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not JSON */
    }
    throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const r = (await res.json()) as ValidationReport;
  if (!Array.isArray(r.errors) || typeof r.riskScore !== 'number') throw new Error('API returned an unexpected shape');
  return r;
}

// ── The scan ────────────────────────────────────────────────────────────────

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fixed-width progress line: `[  3/47] marts/fct_revenue.sql   ✗ 25 CRITICAL`. ✗ marks a Critical finding only. */
export function progressLine(index: number, total: number, path: string, result: BatchFileResult): string {
  const width = String(total).length;
  const counter = `[${String(index).padStart(width)}/${total}]`;
  const hasCritical = result.issues.some((i) => i.severity === 'Critical');
  const mark = hasCritical ? '✗' : '✓';
  const tag = hasCritical ? ' CRITICAL' : '';
  return `${counter} ${path.padEnd(40)} ${mark} ${result.score}${tag}`;
}

export function aggregate(
  files: BatchFileResult[],
  meta: BatchScanResult['meta'],
  bundleHash: string | null = null,
): BatchScanResult {
  const byDetector = new Map<string, BatchDetectorRow>();
  let critical = 0;
  let risky = 0;
  let review = 0;
  for (const f of files) {
    for (const i of f.issues) {
      if (i.severity === 'Critical') critical++;
      else if (i.severity === 'Risky') risky++;
      else review++;
      let row = byDetector.get(i.detector);
      if (!row) {
        row = { detector: i.detector, severity: i.severity, fire_count: 0, files: [] };
        byDetector.set(i.detector, row);
      }
      row.fire_count++;
      if (!row.files.includes(f.path)) row.files.push(f.path);
      // A detector can fire at different severities across files (custom
      // rules, dialect notes); the row shows the worst one.
      if (SEVERITY_RANK[i.severity] < SEVERITY_RANK[row.severity]) row.severity = i.severity;
    }
  }
  const by_detector = [...byDetector.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.fire_count - a.fire_count ||
      a.detector.localeCompare(b.detector),
  );
  const withIssues = files.filter((f) => f.issues.length > 0).length;
  const avg = files.length === 0 ? 100 : Math.round((files.reduce((n, f) => n + f.score, 0) / files.length) * 10) / 10;
  return {
    meta,
    summary: {
      files_with_issues: withIssues,
      files_clean: files.length - withIssues,
      critical_count: critical,
      risky_count: risky,
      review_count: review,
      avg_score: avg,
    },
    by_detector,
    files,
    bundle_hash: bundleHash,
  };
}

/** Top N findings: severity first (Critical → Review), then lowest file score, then path. */
export function topFindings(result: BatchScanResult, limit = TOP_FINDINGS): RankedFinding[] {
  const all: RankedFinding[] = [];
  for (const f of result.files) for (const i of f.issues) all.push({ ...i, path: f.path, score: f.score });
  all.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.score - b.score ||
      a.path.localeCompare(b.path) ||
      a.detector.localeCompare(b.detector),
  );
  return all.slice(0, limit);
}

/**
 * Validate every file in `files` (relative to opts.dir, as discoverSqlFiles
 * returns them), sequentially. With an API key each file is POSTed to
 * /api/validate (Pro detectors, Business custom rules, chain logging) with a
 * small delay between calls; any API failure falls back to the local engine
 * for that file and says so on the progress stream.
 */
export async function runBatchScan(files: string[], opts: BatchScanOptions): Promise<BatchScanResult> {
  const progress = opts.progress ?? ((l: string) => process.stderr.write(l + '\n'));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const dialect = opts.dialect ?? 'postgresql';
  const threshold = opts.threshold ?? 100;
  const started = now();
  const dbt = opts.dbtArtifacts ? prepareDbtContext(opts.dbtArtifacts) : undefined;

  progress('SafeSQL Pro — Batch Scan');
  progress(`Directory: ${opts.dir}`);
  progress(`Files found: ${files.length}`);
  progress(`Dialect: ${dialect}`);
  if (dbt) {
    const s = summarizeDbtContext(dbt.context);
    const loaded = ['manifest.json', s.artifacts.catalog && 'catalog.json', s.artifacts.runResults && 'run_results.json']
      .filter(Boolean)
      .join(', ');
    progress(`dbt context: loaded (${loaded})`);
    for (const w of dbt.warnings) progress(`  dbt warning: ${w}`);
  } else {
    progress('dbt context: not loaded');
  }
  if (files.length === 0) progress('No .sql files found — nothing to scan.');
  progress('');

  const results: BatchFileResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    const abs = join(resolve(opts.dir), path);
    let sql: string;
    try {
      sql = read(abs);
    } catch (e) {
      progress(`[${i + 1}/${files.length}] ${path}  ! unreadable: ${(e as Error).message}`);
      continue;
    }
    let report: ValidationReport;
    if (opts.apiKey) {
      try {
        report = await apiValidate(sql, path, opts, dbt);
      } catch (e) {
        progress(`  ! ${path}: ${(e as Error).message} — validated locally instead`);
        report = localValidate(sql, path, opts, dbt);
      }
      if (i < files.length - 1) await sleep(opts.apiDelayMs ?? API_DELAY_MS);
    } else {
      report = localValidate(sql, path, opts, dbt);
    }
    const fr = fileResultOf(path, sql, report, threshold);
    results.push(fr);
    progress(progressLine(i + 1, files.length, path, fr));
  }

  const duration = now() - started;
  const result = aggregate(results, {
    scanned_dir: opts.dir,
    date: (opts.date?.() ?? new Date()).toISOString(),
    files_scanned: results.length,
    detector_version: DETECTOR_VERSION,
    dialect,
    dbt_context: Boolean(dbt),
    scan_duration_ms: duration,
  });
  const issueCount = result.summary.critical_count + result.summary.risky_count + result.summary.review_count;
  progress('');
  progress(`Scan complete in ${duration.toLocaleString('en-US')}ms`);
  progress(
    `Issues found: ${result.summary.files_with_issues} files · ${issueCount} issues · ${result.summary.critical_count} critical`,
  );
  return result;
}

// ── Formatters ──────────────────────────────────────────────────────────────

/** Escape the one character that breaks a Markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export interface ReportContext {
  /** Product version printed in the header (cli/package.json version). */
  appVersion: string;
  detectorCount: number;
}

export function formatMarkdownReport(r: BatchScanResult, ctx: ReportContext): string {
  const s = r.summary;
  const top = topFindings(r);
  const withIssues = r.files.filter((f) => f.issues.length > 0);
  const clean = r.files.filter((f) => f.issues.length === 0);
  const L: string[] = [];

  L.push('---');
  L.push('# SafeSQL Pro — SQL Health Check Report');
  L.push(`**Scanned:** ${r.meta.scanned_dir}`);
  L.push(`**Date:** ${r.meta.date}`);
  L.push(`**Files scanned:** ${r.meta.files_scanned}`);
  L.push(`**Detector version:** ${r.meta.detector_version}`);
  L.push(`**Dialect:** ${r.meta.dialect}`);
  L.push('', '---', '');

  L.push('## Executive Summary', '');
  L.push('| | Count |');
  L.push('|---|---|');
  L.push(`| Files scanned | ${r.meta.files_scanned} |`);
  L.push(`| Files with issues | ${s.files_with_issues} |`);
  L.push(`| Files clean | ${s.files_clean} |`);
  L.push(`| Critical issues | ${s.critical_count} |`);
  L.push(`| Risky issues | ${s.risky_count} |`);
  L.push(`| Review issues | ${s.review_count} |`);
  L.push(`| Overall health score | ${s.avg_score}/100 |`);
  L.push('', '---', '');

  L.push('## Risk Matrix — Issues by Detector', '');
  L.push('| Detector | Fires | Severity | Files affected |');
  L.push('|---|---|---|---|');
  if (r.by_detector.length === 0) L.push('| — | 0 | — | — |');
  for (const d of r.by_detector) {
    L.push(`| ${d.detector} | ${d.fire_count} | ${d.severity} | ${cell(d.files.join(', '))} |`);
  }
  L.push('', '---', '');

  L.push(`## Top ${TOP_FINDINGS} Findings (by severity)`, '');
  if (top.length === 0) L.push('No findings — every file scanned clean.', '');
  top.forEach((f, idx) => {
    L.push(`### ${idx + 1}. ${f.detector} — ${f.path}`);
    L.push(`**Severity:** ${f.severity}`);
    L.push(`**Score:** ${f.score}/100`);
    if (f.line !== null) L.push(`**Location:** Line ${f.line}`);
    L.push(`**Issue:** ${f.message}`);
    L.push(`**Fix:** ${f.fix || '—'}`);
    L.push('');
  });
  L.push('---', '');

  L.push('## File-by-File Results', '');
  if (withIssues.length === 0) L.push('No files with issues.', '');
  for (const f of withIssues) {
    L.push(`### ${f.path}`);
    L.push(`Score: ${f.score}/100 · ${f.issues.length} issue${f.issues.length === 1 ? '' : 's'}`, '');
    L.push('| Detector | Severity | Message |');
    L.push('|---|---|---|');
    for (const i of f.issues) L.push(`| ${i.detector} | ${i.severity} | ${cell(i.message)} |`);
    L.push('');
  }
  L.push('---', '');

  L.push(`## Clean Files (${clean.length})`);
  for (const f of clean) L.push(f.path);
  L.push('', '---', '');

  L.push('## Methodology');
  L.push(`- SafeSQL Pro v${ctx.appVersion}`);
  L.push(`- ${ctx.detectorCount} deterministic AST-based detectors`);
  L.push(`- Dialect: ${r.meta.dialect}`);
  L.push(`- dbt context: ${r.meta.dbt_context ? 'loaded' : 'not loaded'}`);
  L.push(`- Scan duration: ${r.meta.scan_duration_ms}ms`);
  L.push(`- For questions: ${CONTACT_EMAIL}`);
  L.push('', '---');
  L.push('*Generated by SafeSQL Pro · safesqlpro.dev*');
  L.push(`*Evidence bundle: ${r.bundle_hash ?? 'not generated'}*`);
  if (!r.bundle_hash) L.push('', NO_BUNDLE_NOTE);
  L.push('');
  return L.join('\n');
}

export function formatJsonReport(r: BatchScanResult): string {
  // Key order is the schema's order — `r` is built that way in aggregate().
  return JSON.stringify(r, null, 2) + '\n';
}

/** Plain text: one block per file in the single-file command's layout, plus the summary. */
export function formatTextReport(r: BatchScanResult): string {
  const L: string[] = [];
  L.push('SafeSQL Pro — SQL Health Check');
  L.push(`Scanned: ${r.meta.scanned_dir} · ${r.meta.files_scanned} files · dialect ${r.meta.dialect}`);
  L.push('');
  for (const f of r.files) {
    L.push(`${f.path} — score ${f.score} [${verdictFor(f.score)}]`);
    for (const i of f.issues) {
      L.push(`  ${i.severity.toUpperCase()} ${i.detector}: ${i.message}`);
      if (i.fix) L.push(`     fix: ${i.fix}`);
    }
    L.push('');
  }
  const s = r.summary;
  L.push(
    `${r.meta.files_scanned} files · ${s.files_with_issues} with issues · ${s.critical_count} critical, ${s.risky_count} risky, ${s.review_count} review · health ${s.avg_score}/100`,
  );
  L.push(`Evidence bundle: ${r.bundle_hash ?? 'not generated'}`);
  if (!r.bundle_hash) L.push(NO_BUNDLE_NOTE);
  L.push('');
  return L.join('\n');
}

export type ReportFormat = 'markdown' | 'json' | 'text';

export function formatReport(r: BatchScanResult, format: ReportFormat, ctx: ReportContext): string {
  if (format === 'json') return formatJsonReport(r);
  if (format === 'text') return formatTextReport(r);
  return formatMarkdownReport(r, ctx);
}

// ── Signed evidence bundle (Feature 4) ──────────────────────────────────────
// Calls POST /api/teams/evidence/bundle for the scan window, then downloads
// the archive. The route is session-authenticated today, so an API key is
// answered with 401 — reported plainly, never thrown; the report still ships
// with bundle_hash null. Server-side key auth is a separate follow-up.

export interface SignResult {
  ok: boolean;
  bundleHash?: string;
  filename?: string;
  bytes?: Uint8Array;
  error?: string;
}

export function bundleFilenameFor(date: Date, bundleHash: string): string {
  return `safesql-health-check-${date.toISOString().slice(0, 10)}-${bundleHash.slice(0, 8)}.zip`;
}

export async function requestSignedBundle(opts: {
  apiKey: string;
  apiBase?: string;
  periodFrom: Date;
  periodTo: Date;
  fetch?: typeof fetch;
}): Promise<SignResult> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` };
  let res: Response;
  try {
    res = await doFetch(`${base}/api/teams/evidence/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ period_from: opts.periodFrom.toISOString(), period_to: opts.periodTo.toISOString() }),
    });
  } catch (e) {
    return { ok: false, error: `could not reach ${base}: ${(e as Error).message}` };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error:
        'evidence bundle requires a Business team session — API-key auth for bundles lands in a follow-up. ' +
        'Generate one at safesqlpro.dev/#/team → Evidence Bundles.',
    };
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not JSON */
    }
    return { ok: false, error: `bundle request failed (${res.status})${detail ? `: ${detail}` : ''}` };
  }
  const created = (await res.json()) as { bundle?: { bundle_hash?: string }; download_url?: string };
  const bundleHash = created.bundle?.bundle_hash;
  if (!bundleHash || !created.download_url) return { ok: false, error: 'bundle response missing bundle_hash / download_url' };
  const dl = await doFetch(created.download_url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
  if (!dl.ok) return { ok: false, bundleHash, error: `bundle download failed (${dl.status})` };
  const bytes = new Uint8Array(await dl.arrayBuffer());
  return { ok: true, bundleHash, bytes, filename: bundleFilenameFor(opts.periodTo, bundleHash) };
}
