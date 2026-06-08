import { describe, expect, it } from 'vitest';
import { runValidation, validateSqlSource } from '../services/fileValidation';
import type { ValidationReport } from '../types/validation';

// The CLI (cli/index.ts) is a thin wrapper that reads files then calls these.
describe('CLI engine (fileValidation)', () => {
  it('produces human-readable output with score, verdict, and issue', () => {
    const { output } = runValidation({
      sql: 'DELETE FROM users',
      filename: 'danger.sql',
    });
    expect(output).toMatch(/danger\.sql/);
    expect(output).toMatch(/\[RISKY\]/);
    expect(output).toMatch(/MISSING_WHERE_DESTRUCTIVE/);
    expect(output).toMatch(/error\(s\)/);
  });

  it('--json produces valid JSON matching the ValidationReport shape', () => {
    const { output } = runValidation({ sql: 'DELETE FROM users', json: true });
    const parsed = JSON.parse(output) as ValidationReport;
    expect(typeof parsed.riskScore).toBe('number');
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(Array.isArray(parsed.suggestions)).toBe(true);
    expect(parsed.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
  });

  it('exits 1 on errors, 0 on a clean query', () => {
    expect(runValidation({ sql: 'DELETE FROM users' }).exitCode).toBe(1);
    expect(runValidation({ sql: 'SELECT id FROM users WHERE id = 1' }).exitCode).toBe(0);
  });

  it('--schema enables schema-dependent detectors', () => {
    const ddl = 'CREATE TABLE users (id UUID PRIMARY KEY, email TEXT);';
    const withSchema = validateSqlSource('SELECT id, lifetime_value FROM users', ddl);
    expect(withSchema.errors.map((e) => e.id)).toContain('HALLUCINATED_COLUMN');
    const noSchema = validateSqlSource('SELECT id, lifetime_value FROM users');
    expect(noSchema.errors.map((e) => e.id)).not.toContain('HALLUCINATED_COLUMN');
  });
});
