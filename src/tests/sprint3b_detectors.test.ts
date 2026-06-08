import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import type { ValidationReport } from '../types/validation';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';
const v = (sql: string, dialect: Dialect = 'postgresql'): ValidationReport =>
  validateSQL({ sql, dialect });
const ids = (r: ValidationReport) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

// 1 — COALESCE_IN_JOIN_KEY
describe('COALESCE_IN_JOIN_KEY', () => {
  it('flags COALESCE wrapping a join key (warning, 41-69)', () => {
    const r = v('SELECT u.id FROM users u JOIN orders o ON COALESCE(o.user_id, 0) = u.id');
    expect(ids(r)).toContain('COALESCE_IN_JOIN_KEY');
    const issue = r.warnings.find((w) => w.id === 'COALESCE_IN_JOIN_KEY')!;
    expect(issue.offendingClause).toBe('JOIN');
    expect(issue.fix).toMatch(/IS NOT NULL/i);
    expect(r.riskScore).toBeLessThan(70);
  });

  it('does NOT flag a plain join key', () => {
    const r = v('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).not.toContain('COALESCE_IN_JOIN_KEY');
  });
});

// 2 — WINDOW_MISSING_ORDER
describe('WINDOW_MISSING_ORDER', () => {
  it('flags ROW_NUMBER() with no ORDER BY (warning, 41-69)', () => {
    const r = v('SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id) AS rn FROM orders');
    expect(ids(r)).toContain('WINDOW_MISSING_ORDER');
    expect(r.warnings.find((w) => w.id === 'WINDOW_MISSING_ORDER')!.fix).toMatch(/ORDER BY/);
    expect(r.riskScore).toBeLessThan(70);
  });

  it('does NOT flag when an ORDER BY is present', () => {
    const r = v(
      'SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY total_amount DESC, id) AS rn FROM orders',
    );
    expect(ids(r)).not.toContain('WINDOW_MISSING_ORDER');
  });
});

// 3 — MISSING_TIME_FILTER bare scan of an event/log table
describe('MISSING_TIME_FILTER (bare event-table scan)', () => {
  it('flags SELECT * FROM events with no time filter', () => {
    const r = v('SELECT * FROM events');
    expect(ids(r)).toContain('MISSING_TIME_FILTER');
    expect(r.riskScore).toBeLessThan(70);
  });

  it('flags a non-aggregate scan of logs', () => {
    const r = v('SELECT id, message FROM logs');
    expect(ids(r)).toContain('MISSING_TIME_FILTER');
  });

  it('does NOT flag non-event tables (users / products / orders)', () => {
    expect(ids(v('SELECT * FROM users'))).not.toContain('MISSING_TIME_FILTER');
    expect(ids(v('SELECT * FROM products'))).not.toContain('MISSING_TIME_FILTER');
    expect(ids(v('SELECT * FROM orders'))).not.toContain('MISSING_TIME_FILTER');
  });

  it('does NOT flag when a date filter is already present', () => {
    const r = v("SELECT id FROM events WHERE created_at >= '2024-01-01'");
    expect(ids(r)).not.toContain('MISSING_TIME_FILTER');
  });
});

// 4 — IMPLICIT_TIMEZONE
describe('IMPLICIT_TIMEZONE', () => {
  it('flags a naive timestamp comparison (suggestion, safe band)', () => {
    const r = v("SELECT id FROM events WHERE created_at > '2024-01-01'");
    expect(ids(r)).toContain('IMPLICIT_TIMEZONE');
    const issue = r.suggestions.find((s) => s.id === 'IMPLICIT_TIMEZONE')!;
    expect(issue.severity).toBe('suggestion');
    expect(issue.offendingColumn).toBe('created_at');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });

  it('does NOT flag a timezone-aware literal', () => {
    const r = v("SELECT id FROM events WHERE created_at > '2024-01-01T00:00:00Z'");
    expect(ids(r)).not.toContain('IMPLICIT_TIMEZONE');
  });

  it('does NOT flag a non-date column compared to a string', () => {
    const r = v("SELECT id FROM users WHERE email = '2024-01-01'");
    expect(ids(r)).not.toContain('IMPLICIT_TIMEZONE');
  });
});

// 5 — DIALECT_MISMATCH: MySQL LIMIT a,b and SQL Server TOP
describe('DIALECT_MISMATCH (LIMIT a,b / TOP)', () => {
  it('flags MySQL `LIMIT 10,5` in PostgreSQL (warning, not a syntax error)', () => {
    const r = v('SELECT * FROM users LIMIT 10,5', 'postgresql');
    expect(ids(r)).toContain('DIALECT_MISMATCH');
    expect(ids(r)).not.toContain('SYNTAX_ERROR');
    const issue = r.warnings.find((w) => w.id === 'DIALECT_MISMATCH')!;
    expect(issue.fix).toMatch(/LIMIT 5 OFFSET 10/);
    expect(r.riskScore).toBeGreaterThanOrEqual(41);
    expect(r.riskScore).toBeLessThan(70);
  });

  it('does NOT flag `LIMIT 10,5` in MySQL mode (valid there)', () => {
    const r = v('SELECT * FROM users LIMIT 10,5', 'mysql');
    expect(ids(r)).not.toContain('DIALECT_MISMATCH');
  });

  it('flags SQL Server `TOP 10` (warning, not a syntax error)', () => {
    const r = v('SELECT TOP 10 * FROM users', 'postgresql');
    expect(ids(r)).toContain('DIALECT_MISMATCH');
    expect(ids(r)).not.toContain('SYNTAX_ERROR');
    expect(r.warnings.find((w) => w.id === 'DIALECT_MISMATCH')!.fix).toMatch(/LIMIT 10/);
    expect(r.riskScore).toBeLessThan(70);
  });
});
