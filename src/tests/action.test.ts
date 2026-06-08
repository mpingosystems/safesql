import { describe, expect, it } from 'vitest';
import {
  anyFailing,
  exitCodeFor,
  summaryTable,
  validateSqlSource,
  type FileResult,
} from '../services/fileValidation';

// The GitHub Action (action/src/index.ts) globs files, reads them, then calls
// these shared functions to build the PR summary + decide pass/fail.
describe('GitHub Action engine (fileValidation)', () => {
  it('validates a file source and returns a report', () => {
    const report = validateSqlSource('DELETE FROM users');
    expect(report.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
  });

  it('fails (exit 1) when errors present, passes (0) when clean', () => {
    expect(exitCodeFor(validateSqlSource('DELETE FROM users'))).toBe(1);
    expect(exitCodeFor(validateSqlSource('SELECT id FROM users WHERE id = 1'))).toBe(0);
  });

  it('--fail-on-warnings turns a warning-only result into exit 1', () => {
    const report = validateSqlSource('SELECT * FROM transactions'); // columnar → warning
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.errors.length).toBe(0);
    expect(exitCodeFor(report, false)).toBe(0);
    expect(exitCodeFor(report, true)).toBe(1);
  });

  it('builds a markdown summary table and an aggregate fail decision', () => {
    const results: FileResult[] = [
      { filename: 'bad.sql', report: validateSqlSource('DELETE FROM users') },
      { filename: 'good.sql', report: validateSqlSource('SELECT id FROM users WHERE id = 1') },
    ];
    const table = summaryTable(results);
    expect(table).toMatch(/\| File \| Score \| Errors \| Warnings \|/);
    expect(table).toMatch(/\| bad\.sql \| \d+ \| 1 \| 0 \|/);
    expect(table).toMatch(/\| good\.sql \| 100 \| 0 \| 0 \|/);
    expect(anyFailing(results)).toBe(true);
    expect(anyFailing([results[1]])).toBe(false);
  });
});
