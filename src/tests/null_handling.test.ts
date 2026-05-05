import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition } from '../types/validation';

const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    deleted_at TIMESTAMPTZ,
    age INTEGER
  );
  CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    cancelled_user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2)
  );
`);

type SchemaArg = SchemaDefinition | undefined | null;
const v = (sql: string, schema: SchemaArg = SCHEMA) => {
  const effective = schema === null ? undefined : schema;
  return validateSQL({ sql, schema: effective, dialect: 'postgresql' });
};

describe('D10: NULL_EQUALITY_COMPARISON', () => {
  it("flags `col = NULL` in WHERE", () => {
    const r = v('SELECT id FROM users WHERE deleted_at = NULL');
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
    const issue = r.errors.find((e) => e.id === 'NULL_EQUALITY_COMPARISON')!;
    expect(issue.fix).toMatch(/IS NULL/);
    expect(issue.metadata?.column).toBe('deleted_at');
    expect(issue.metadata?.operator).toBe('=');
  });

  it("flags `col != NULL`", () => {
    const r = v('SELECT id FROM users WHERE deleted_at != NULL');
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
    const issue = r.errors.find((e) => e.id === 'NULL_EQUALITY_COMPARISON')!;
    expect(issue.fix).toMatch(/IS NOT NULL/);
  });

  it("flags `col <> NULL`", () => {
    const r = v('SELECT id FROM users WHERE deleted_at <> NULL');
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
  });

  it('flags inside HAVING', () => {
    const r = v('SELECT id FROM users GROUP BY id HAVING MAX(deleted_at) = NULL');
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
  });

  it('flags inside JOIN ON', () => {
    const r = v('SELECT u.id FROM users u JOIN orders o ON o.cancelled_user_id = NULL');
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
  });

  it('passes the correct form `col IS NULL`', () => {
    const r = v('SELECT id FROM users WHERE deleted_at IS NULL');
    expect(r.errors.find((e) => e.id === 'NULL_EQUALITY_COMPARISON')).toBeUndefined();
  });

  it('passes when comparing two non-NULL values', () => {
    const r = v("SELECT id FROM users WHERE email = 'a@b.com'");
    expect(r.errors.find((e) => e.id === 'NULL_EQUALITY_COMPARISON')).toBeUndefined();
  });

  it('drops risk score below 50 (error severity)', () => {
    const r = v('SELECT id FROM users WHERE deleted_at = NULL');
    expect(r.riskScore).toBeLessThan(50);
    expect(r.executionSafe).toBe(false);
  });

  it('does not require schema to fire', () => {
    const r = v('SELECT id FROM users WHERE deleted_at = NULL', null);
    expect(r.errors.map((e) => e.id)).toContain('NULL_EQUALITY_COMPARISON');
  });
});

describe('D11: NOT_IN_NULLABLE', () => {
  it('flags NOT IN with explicit NULL in the literal list', () => {
    const r = v("SELECT id FROM users WHERE id NOT IN ('a', 'b', NULL)");
    expect(r.warnings.map((w) => w.id)).toContain('NOT_IN_NULLABLE');
    const issue = r.warnings.find((w) => w.id === 'NOT_IN_NULLABLE')!;
    expect(issue.metadata?.source).toBe('literal_list');
    expect(issue.fix).toMatch(/IS NOT NULL|NOT EXISTS/);
  });

  it('flags NOT IN subquery on a nullable column', () => {
    // orders.cancelled_user_id is nullable
    const r = v(
      'SELECT id FROM users WHERE id NOT IN (SELECT cancelled_user_id FROM orders)',
    );
    expect(r.warnings.map((w) => w.id)).toContain('NOT_IN_NULLABLE');
    const issue = r.warnings.find((w) => w.id === 'NOT_IN_NULLABLE')!;
    expect(issue.metadata?.sourceTable).toBe('orders');
    expect(issue.metadata?.sourceColumn).toBe('cancelled_user_id');
  });

  it('does NOT flag NOT IN literal list with no NULL', () => {
    const r = v("SELECT id FROM users WHERE id NOT IN ('a', 'b', 'c')");
    expect(r.warnings.find((w) => w.id === 'NOT_IN_NULLABLE')).toBeUndefined();
  });

  it('passes plain IN (different operator)', () => {
    const r = v("SELECT id FROM users WHERE id IN ('a', 'b', NULL)");
    expect(r.warnings.find((w) => w.id === 'NOT_IN_NULLABLE')).toBeUndefined();
  });

  it('does not flag literal list without schema either', () => {
    const r = v("SELECT id FROM users WHERE id NOT IN ('a', NULL)", null);
    // Literal-list path is schema-independent — should still fire.
    expect(r.warnings.map((w) => w.id)).toContain('NOT_IN_NULLABLE');
  });
});

describe('D12: AVG_OVER_NULLABLE', () => {
  it('flags AVG over a nullable column (qualified)', () => {
    const r = v('SELECT AVG(u.age) FROM users u');
    const ids = [
      ...r.errors.map((i) => i.id),
      ...r.warnings.map((i) => i.id),
      ...r.suggestions.map((i) => i.id),
    ];
    expect(ids).toContain('AVG_OVER_NULLABLE');
    const issue = r.suggestions.find((s) => s.id === 'AVG_OVER_NULLABLE')!;
    expect(issue.metadata?.table).toBe('users');
    expect(issue.metadata?.column).toBe('age');
    expect(issue.fix).toMatch(/COALESCE/);
  });

  it('flags AVG over a nullable column (unqualified, single-table)', () => {
    const r = v('SELECT AVG(age) FROM users');
    expect(r.suggestions.map((s) => s.id)).toContain('AVG_OVER_NULLABLE');
  });

  it('does NOT flag AVG over a NOT NULL column', () => {
    // users.email is NOT NULL — but wait, AVG on TEXT is nonsense. Use users.id (PK, NOT NULL).
    // Actually PK is NOT NULL by definition; AVG over UUID isn't meaningful but the detector
    // only checks nullability. Use `id`.
    const r = v('SELECT AVG(id) FROM users');
    expect(r.suggestions.find((s) => s.id === 'AVG_OVER_NULLABLE')).toBeUndefined();
  });

  it('does NOT flag SUM or COUNT (only AVG is the trickier case)', () => {
    const r1 = v('SELECT SUM(age) FROM users');
    expect(r1.suggestions.find((s) => s.id === 'AVG_OVER_NULLABLE')).toBeUndefined();
    const r2 = v('SELECT COUNT(age) FROM users');
    expect(r2.suggestions.find((s) => s.id === 'AVG_OVER_NULLABLE')).toBeUndefined();
  });

  it('does not run without a schema', () => {
    const r = v('SELECT AVG(age) FROM users', null);
    expect(r.suggestions.find((s) => s.id === 'AVG_OVER_NULLABLE')).toBeUndefined();
  });
});
