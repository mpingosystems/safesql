import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { ValidationReport } from '../types/validation';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';
const v = (sql: string, dialect: Dialect): ValidationReport => validateSQL({ sql, dialect });
const ids = (r: ValidationReport) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);
const dm = (r: ValidationReport) =>
  [...r.warnings, ...r.suggestions, ...r.errors].filter((i) => i.id === 'DIALECT_MISMATCH');

const QUALIFY =
  'SELECT a, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) rn FROM t QUALIFY rn = 1';
const BACKTICK = 'SELECT `user_id` FROM `proj.ds.tbl`';
const FLATTEN = 'SELECT f.value FROM t, LATERAL FLATTEN(input => t.col) f';

describe('DIALECT_MISMATCH — Sprint 6 triggers', () => {
  it('QUALIFY flagged in PostgreSQL mode, clean in Snowflake', () => {
    const pg = v(QUALIFY, 'postgresql');
    expect(ids(pg)).toContain('DIALECT_MISMATCH');
    expect(ids(pg)).not.toContain('SYNTAX_ERROR'); // surfaced as dialect, not syntax error
    expect(dm(pg)[0].metadata?.construct).toBe('qualify');
    expect(ids(v(QUALIFY, 'snowflake'))).not.toContain('DIALECT_MISMATCH');
  });

  it('backtick identifiers flagged in PostgreSQL mode, clean in BigQuery', () => {
    expect(ids(v(BACKTICK, 'postgresql'))).toContain('DIALECT_MISMATCH');
    expect(ids(v(BACKTICK, 'bigquery'))).not.toContain('DIALECT_MISMATCH');
  });

  it('LATERAL FLATTEN flagged in PostgreSQL mode, clean in Snowflake', () => {
    const pg = v(FLATTEN, 'postgresql');
    expect(ids(pg)).toContain('DIALECT_MISMATCH');
    expect(ids(pg)).not.toContain('SYNTAX_ERROR');
    expect(ids(v(FLATTEN, 'snowflake'))).not.toContain('DIALECT_MISMATCH');
  });

  it('|| with string literals → suggestion in PostgreSQL', () => {
    const r = v("SELECT id FROM users WHERE name = 'foo' || 'bar'", 'postgresql');
    const hit = r.suggestions.find((s) => s.id === 'DIALECT_MISMATCH');
    expect(hit).toBeDefined();
    expect(hit!.metadata?.construct).toBe('double_pipe');
  });
});

describe('Dialect-aware linting on existing detectors', () => {
  const SCHEMA = parseDDL('CREATE TABLE orders (id UUID PRIMARY KEY, user_id UUID, amount NUMERIC);');

  it('D3 INCOMPLETE_GROUP_BY adds a MySQL note in MySQL mode', () => {
    const r = validateSQL({ sql: 'SELECT user_id, SUM(amount) FROM orders', dialect: 'mysql' });
    const issue = r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')!;
    expect(issue.fix).toMatch(/MySQL allows this/);
  });

  it('D3 fix has no MySQL note in PostgreSQL mode', () => {
    const r = validateSQL({ sql: 'SELECT user_id, SUM(amount) FROM orders', dialect: 'postgresql' });
    const issue = r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')!;
    expect(issue.fix).not.toMatch(/MySQL allows this/);
  });

  it('D5 SELECT_STAR severity = warning in BigQuery mode (not suggestion)', () => {
    const bq = validateSQL({ sql: 'SELECT * FROM products', schema: SCHEMA, dialect: 'bigquery' });
    const star = [...bq.warnings, ...bq.suggestions].find((i) => i.id === 'SELECT_STAR_EXPENSIVE')!;
    expect(star.severity).toBe('warning');
    expect(star.description).toMatch(/BigQuery/);
    // Same query is a suggestion in PostgreSQL.
    const pg = validateSQL({ sql: 'SELECT * FROM products', schema: SCHEMA, dialect: 'postgresql' });
    expect(pg.suggestions.find((s) => s.id === 'SELECT_STAR_EXPENSIVE')!.severity).toBe('suggestion');
  });

  it('D10 NULL_EQUALITY fix notes it applies in all dialects', () => {
    const r = validateSQL({ sql: 'SELECT id FROM users WHERE deleted_at = NULL', dialect: 'mysql' });
    expect(r.errors.find((e) => e.id === 'NULL_EQUALITY_COMPARISON')!.fix).toMatch(/all SQL dialects/);
  });
});
