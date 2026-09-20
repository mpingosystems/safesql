import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NO_BUNDLE_NOTE,
  SIGN_NEEDS_KEY_WARNING,
  discoverSqlFiles,
  formatJsonReport,
  formatMarkdownReport,
  formatTextReport,
  globToRegExp,
  requestSignedBundle,
  runBatchScan,
  topFindings,
  type BatchScanResult,
} from './batchScan';
import { DETECTOR_VERSION } from '../src/config/detectorVersion';

// Sprint 9.5A-pre — `safesql scan`. Lives beside the code (cli/) because it
// touches the filesystem; src/ tests cannot import node:*.

// Fixture SQL with known engine outcomes (probed against v0.11.0):
const CLEAN = 'SELECT id, name FROM customers WHERE id = 5';                         // 100
const DROP = 'DROP TABLE users';                                                      // 25, DESTRUCTIVE_DDL error
const DELETE_ALL = 'DELETE FROM orders';                                              // 25, MISSING_WHERE_DESTRUCTIVE error
const STAR = 'SELECT * FROM orders';                                                  // 95, SELECT_STAR_EXPENSIVE suggestion
const LEFT_WHERE =
  "SELECT c.id FROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.status = 'paid'"; // 60, 2 warnings

let dir: string;
const write = (rel: string, sql: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, sql, 'utf8');
};
const quiet = (): string[] => [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'safesql-scan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Standard 5-file tree used by the aggregation + report tests. */
function seedTree(): string[] {
  write('marts/fct_revenue.sql', LEFT_WHERE);
  write('marts/dim_products.sql', STAR);
  write('staging/stg_orders.sql', CLEAN);
  write('ops/drop_users.sql', DROP);
  write('ops/purge.sql', DELETE_ALL);
  return discoverSqlFiles(dir);
}

async function scanTree(extra: Partial<Parameters<typeof runBatchScan>[1]> = {}): Promise<{ result: BatchScanResult; progress: string[] }> {
  const files = seedTree();
  const progress: string[] = [];
  const result = await runBatchScan(files, { dir, progress: (l) => progress.push(l), now: () => 0, ...extra });
  return { result, progress };
}

const REPORT_CTX = { appVersion: '0.11.0', detectorCount: 35 };

describe('1. file discovery finds .sql files recursively', () => {
  it('walks nested directories, returns sorted POSIX-relative paths, ignores non-SQL', () => {
    write('a/deep/er/three.sql', CLEAN);
    write('b.sql', CLEAN);
    write('a/one.SQL', CLEAN);
    write('a/notes.md', '# nope');
    write('a/one.sql.bak', CLEAN);
    expect(discoverSqlFiles(dir)).toEqual(['a/deep/er/three.sql', 'a/one.SQL', 'b.sql']);
  });
});

describe('2. file discovery excludes node_modules, .git and target/', () => {
  it('skips the excluded directories at any depth', () => {
    write('models/keep.sql', CLEAN);
    write('node_modules/pkg/skip.sql', CLEAN);
    write('.git/hooks/skip.sql', CLEAN);
    write('target/compiled/skip.sql', CLEAN);
    write('models/target/run/skip.sql', CLEAN);
    write('models/vendor/node_modules/skip.sql', CLEAN);
    expect(discoverSqlFiles(dir)).toEqual(['models/keep.sql']);
  });
});

describe('3. file discovery respects --exclude glob', () => {
  it('drops files matching a ** glob, a bare basename glob and a single-segment glob', () => {
    write('models/a.sql', CLEAN);
    write('models/a.test.sql', CLEAN);
    write('models/deep/b.test.sql', CLEAN);
    write('scratch/tmp.sql', CLEAN);
    expect(discoverSqlFiles(dir, '**/*.test.sql')).toEqual(['models/a.sql', 'scratch/tmp.sql']);
    expect(discoverSqlFiles(dir, '*.test.sql')).toEqual(['models/a.sql', 'scratch/tmp.sql']);
    expect(discoverSqlFiles(dir, 'scratch/*.sql')).toEqual(['models/a.sql', 'models/a.test.sql', 'models/deep/b.test.sql']);
    // the translation itself
    expect(globToRegExp('**/*.test.sql').test('x/y/z.test.sql')).toBe(true);
    expect(globToRegExp('**/*.test.sql').test('z.test.sql')).toBe(true);
    expect(globToRegExp('models/?.sql').test('models/a.sql')).toBe(true);
    expect(globToRegExp('models/?.sql').test('models/ab.sql')).toBe(false);
  });
});

describe('4. batch scan produces correct summary counts', () => {
  it('counts files, issues by severity and the average score', async () => {
    const { result } = await scanTree();
    expect(result.meta).toMatchObject({
      scanned_dir: dir,
      files_scanned: 5,
      detector_version: DETECTOR_VERSION,
      dialect: 'postgresql',
      dbt_context: false,
      scan_duration_ms: 0,
    });
    expect(result.summary).toEqual({
      files_with_issues: 4,
      files_clean: 1,
      critical_count: 2, // DROP + DELETE
      risky_count: 2, // the two LEFT JOIN warnings
      review_count: 1, // SELECT *
      avg_score: 61, // (60 + 95 + 100 + 25 + 25) / 5
    });
    expect(result.files.map((f) => f.path)).toEqual([
      'marts/dim_products.sql',
      'marts/fct_revenue.sql',
      'ops/drop_users.sql',
      'ops/purge.sql',
      'staging/stg_orders.sql',
    ]);
    expect(result.bundle_hash).toBeNull();
    // line numbers come from the locator: the WHERE clause is on line 3
    const leftWhere = result.files.find((f) => f.path === 'marts/fct_revenue.sql')!;
    expect(leftWhere.issues.find((i) => i.detector === 'LEFT_JOIN_FILTERED_IN_WHERE')?.line).toBe(3);
  });
});

describe('5. top 10 sorted by severity then score', () => {
  it('puts Critical first, then Risky, then Review; lowest score first inside a band', async () => {
    const { result } = await scanTree();
    const top = topFindings(result);
    expect(top.map((t) => t.severity)).toEqual(['Critical', 'Critical', 'Risky', 'Risky', 'Review']);
    expect(top.map((t) => t.path)).toEqual([
      'ops/drop_users.sql',
      'ops/purge.sql',
      'marts/fct_revenue.sql',
      'marts/fct_revenue.sql',
      'marts/dim_products.sql',
    ]);
    // and the limit holds
    expect(topFindings(result, 2)).toHaveLength(2);
  });
});

describe('6. markdown report contains all required sections', () => {
  it('renders every heading, the header fields and the methodology footer', async () => {
    const { result } = await scanTree();
    const md = formatMarkdownReport(result, REPORT_CTX);
    for (const h of [
      '# SafeSQL Pro — SQL Health Check Report',
      '## Executive Summary',
      '## Risk Matrix — Issues by Detector',
      '## Top 10 Findings (by severity)',
      '## File-by-File Results',
      '## Clean Files (1)',
      '## Methodology',
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain(`**Scanned:** ${dir}`);
    expect(md).toContain('**Files scanned:** 5');
    expect(md).toContain(`**Detector version:** ${DETECTOR_VERSION}`);
    expect(md).toContain('| Overall health score | 61/100 |');
    expect(md).toContain('| DESTRUCTIVE_DDL | 1 | Critical | ops/drop_users.sql |');
    expect(md).toContain('### 1. DESTRUCTIVE_DDL — ops/drop_users.sql');
    expect(md).toContain('**Severity:** Critical');
    expect(md).toContain('**Location:** Line 3');
    expect(md).toContain('### marts/fct_revenue.sql\nScore: 60/100 · 2 issues');
    expect(md).toContain('- SafeSQL Pro v0.11.0');
    expect(md).toContain('- 35 deterministic AST-based detectors');
    expect(md).toContain('- dbt context: not loaded');
    expect(md).toContain('- For questions: eddy@mpingo.ai');
    expect(md).toContain('*Evidence bundle: not generated*');
    expect(md).toContain(NO_BUNDLE_NOTE);
    expect(md.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('7. markdown report lists clean files correctly', () => {
  it('lists only score-100 files under Clean Files and never under File-by-File', async () => {
    const { result } = await scanTree();
    const md = formatMarkdownReport(result, REPORT_CTX);
    const cleanSection = md.slice(md.indexOf('## Clean Files'), md.indexOf('## Methodology'));
    expect(cleanSection).toContain('staging/stg_orders.sql');
    expect(cleanSection).not.toContain('marts/');
    expect(cleanSection).not.toContain('ops/');
    const fileSection = md.slice(md.indexOf('## File-by-File Results'), md.indexOf('## Clean Files'));
    expect(fileSection).not.toContain('stg_orders');
    // a 95 with a suggestion is NOT clean
    expect(fileSection).toContain('### marts/dim_products.sql');
  });
});

describe('8. JSON report matches the schema exactly', () => {
  it('has exactly the documented keys in the documented order and nothing else', async () => {
    const { result } = await scanTree();
    const parsed = JSON.parse(formatJsonReport(result));
    expect(Object.keys(parsed)).toEqual(['meta', 'summary', 'by_detector', 'files', 'bundle_hash']);
    expect(Object.keys(parsed.meta)).toEqual([
      'scanned_dir', 'date', 'files_scanned', 'detector_version', 'dialect', 'dbt_context', 'scan_duration_ms',
    ]);
    expect(Object.keys(parsed.summary)).toEqual([
      'files_with_issues', 'files_clean', 'critical_count', 'risky_count', 'review_count', 'avg_score',
    ]);
    for (const d of parsed.by_detector) expect(Object.keys(d)).toEqual(['detector', 'severity', 'fire_count', 'files']);
    for (const f of parsed.files) {
      expect(Object.keys(f)).toEqual(['path', 'score', 'issues']);
      for (const i of f.issues) {
        expect(Object.keys(i)).toEqual(['detector', 'severity', 'message', 'fix', 'line']);
        expect(['Critical', 'Risky', 'Review']).toContain(i.severity);
        expect(typeof i.fix).toBe('string');
        expect(i.line === null || typeof i.line === 'number').toBe(true);
      }
    }
    expect(parsed.bundle_hash).toBeNull();
    expect(typeof parsed.meta.date).toBe('string');
    expect(new Date(parsed.meta.date).toISOString()).toBe(parsed.meta.date);
  });
});

describe('9. JSON by_detector aggregates correctly', () => {
  it('counts fires across files, lists each affected file once, sorted by severity', async () => {
    write('a.sql', DROP);
    write('b.sql', DROP);
    write('c.sql', STAR);
    write('d.sql', LEFT_WHERE);
    const files = discoverSqlFiles(dir);
    const result = await runBatchScan(files, { dir, progress: quiet, now: () => 0 });
    expect(result.by_detector).toEqual([
      { detector: 'DESTRUCTIVE_DDL', severity: 'Critical', fire_count: 2, files: ['a.sql', 'b.sql'] },
      { detector: 'JOIN_MULTIPLICATION', severity: 'Risky', fire_count: 1, files: ['d.sql'] },
      { detector: 'LEFT_JOIN_FILTERED_IN_WHERE', severity: 'Risky', fire_count: 1, files: ['d.sql'] },
      { detector: 'SELECT_STAR_EXPENSIVE', severity: 'Review', fire_count: 1, files: ['c.sql'] },
    ]);
  });
});

describe('10. progress output goes to stderr, not stdout', () => {
  it('writes every progress line through process.stderr by default and nothing to stdout', async () => {
    const files = seedTree();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let lines: string[];
    let stdoutCalls: number;
    try {
      await runBatchScan(files, { dir, now: () => 1240 });
      // capture before restore — vitest 4 clears call history on mockRestore
      lines = errSpy.mock.calls.map((c) => String(c[0]).trimEnd());
      stdoutCalls = outSpy.mock.calls.length;
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    expect(stdoutCalls).toBe(0);
    expect(lines[0]).toBe('SafeSQL Pro — Batch Scan');
    expect(lines).toContain(`Directory: ${dir}`);
    expect(lines).toContain('Files found: 5');
    expect(lines).toContain('dbt context: not loaded');
    expect(lines.some((l) => /^\[1\/5\] marts\/dim_products\.sql\s+✓ 95$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[3\/5\] ops\/drop_users\.sql\s+✗ 25 CRITICAL$/.test(l))).toBe(true);
    expect(lines).toContain('Scan complete in 0ms'); // now() is constant, so duration 0
    expect(lines).toContain('Issues found: 4 files · 5 issues · 2 critical');
  });
});

describe('11. --sign without --api-key warns and skips, no error', () => {
  it('exposes the exact warning text and a scan without a key never calls fetch', async () => {
    expect(SIGN_NEEDS_KEY_WARNING).toBe('Evidence bundle requires an API key. Get one at safesqlpro.dev/#/settings');
    const fetchSpy = vi.fn();
    const { result } = await scanTree({ fetch: fetchSpy as unknown as typeof fetch });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.bundle_hash).toBeNull();
    expect(formatTextReport(result)).toContain(NO_BUNDLE_NOTE);
  });

  it('with a key, a 401 from the bundle route is reported plainly, never thrown', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    const signed = await requestSignedBundle({
      apiKey: 'ssk_live_test',
      periodFrom: new Date('2026-09-20T00:00:00Z'),
      periodTo: new Date('2026-09-20T01:00:00Z'),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(signed.ok).toBe(false);
    expect(signed.error).toMatch(/Business team session/);
    expect(fetchMock.mock.calls[0][0]).toBe('https://safesqlpro.dev/api/teams/evidence/bundle');
  });
});

describe('12. empty directory: graceful message, no crash', () => {
  it('reports zero files with a full, valid report and a note on the progress stream', async () => {
    const progress: string[] = [];
    const result = await runBatchScan(discoverSqlFiles(dir), { dir, progress: (l) => progress.push(l), now: () => 0 });
    expect(progress).toContain('Files found: 0');
    expect(progress).toContain('No .sql files found — nothing to scan.');
    expect(result.meta.files_scanned).toBe(0);
    expect(result.summary).toEqual({
      files_with_issues: 0, files_clean: 0, critical_count: 0, risky_count: 0, review_count: 0, avg_score: 100,
    });
    expect(result.by_detector).toEqual([]);
    const md = formatMarkdownReport(result, REPORT_CTX);
    expect(md).toContain('No findings — every file scanned clean.');
    expect(md).toContain('## Clean Files (0)');
    // a directory that does not exist behaves the same as an empty one
    expect(discoverSqlFiles(join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('13. --threshold hides files at or above the cut-off', () => {
  it('keeps every file in the count but strips issues from files scoring >= threshold', async () => {
    const { result } = await scanTree({ threshold: 90 });
    expect(result.meta.files_scanned).toBe(5);
    // 95 (SELECT *) is now reported clean; 60 and 25s are still reported
    expect(result.summary.review_count).toBe(0);
    expect(result.summary.files_with_issues).toBe(3);
    expect(result.summary.files_clean).toBe(2);
    expect(result.files.find((f) => f.path === 'marts/dim_products.sql')).toEqual({ path: 'marts/dim_products.sql', score: 95, issues: [] });
  });
});

describe('14. --api-key routes every file through POST /api/validate with the delay, falling back on error', () => {
  it('posts each file with the Bearer key, sleeps between files, and validates locally when the API fails', async () => {
    const files = seedTree();
    const calls: Array<{ url: string; auth: string; sql: string }> = [];
    let n = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { sql: string };
      calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization), sql: body.sql });
      n++;
      if (n === 2) return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      // the API spreads the report at the top level; hand back a "clean" verdict to prove it was used
      return new Response(
        JSON.stringify({ riskScore: 100, executionSafe: true, errors: [], warnings: [], suggestions: [], processingMs: 1, tier: 'pro', detectorVersion: DETECTOR_VERSION }),
        { status: 200 },
      );
    });
    const sleeps: number[] = [];
    const progress: string[] = [];
    const result = await runBatchScan(files, {
      dir,
      apiKey: 'ssk_live_abc',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
      progress: (l) => progress.push(l),
      now: () => 0,
    });
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.url === 'https://safesqlpro.dev/api/validate' && c.auth === 'Bearer ssk_live_abc')).toBe(true);
    expect(calls[0].sql).toBe(STAR); // sorted order: marts/dim_products.sql first
    expect(sleeps).toEqual([10, 10, 10, 10]); // between files, not after the last
    // file 2 (marts/fct_revenue.sql) fell back to the local engine: its real score is 60
    expect(progress.some((l) => l.includes('marts/fct_revenue.sql: API 429: rate limited — validated locally instead'))).toBe(true);
    expect(result.files.map((f) => f.score)).toEqual([100, 60, 100, 100, 100]);
  });
});

describe('15. --output is written BOM-free (Node utf8 never emits a BOM)', () => {
  it('round-trips a markdown report through writeFileSync without a BOM', async () => {
    const { result } = await scanTree();
    const out = join(dir, 'report.md');
    writeFileSync(out, formatMarkdownReport(result, REPORT_CTX), 'utf8');
    const bytes = readFileSync(out);
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('# SafeSQL Pro — SQL Health Check Report');
  });
});
