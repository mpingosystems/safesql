import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition } from '../types/validation';

const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    status TEXT,
    created_at TIMESTAMPTZ
  );
  CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2),
    status TEXT,
    created_at TIMESTAMPTZ
  );
`);

// Pass `null` to opt out of the default schema (graceful-degradation tests).
// Default-parameter resolution would coerce `undefined` back to SCHEMA and
// silently mask the no-schema code path, so we use a sentinel.
type SchemaArg = SchemaDefinition | undefined | null;
const v = (sql: string, schema: SchemaArg = SCHEMA) => {
  const effective = schema === null ? undefined : schema;
  return validateSQL({ sql, schema: effective, dialect: 'postgresql' });
};

describe('D8: HALLUCINATED_TABLE', () => {
  it('flags a SELECT FROM unknown table', () => {
    const r = v('SELECT * FROM customers');
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_TABLE');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_TABLE')!;
    expect(issue.title).toMatch(/customers/);
    expect(issue.metadata?.table).toBe('customers');
  });

  it('flags a JOIN target that does not exist', () => {
    const r = v('SELECT u.id FROM users u JOIN line_items li ON u.id = li.user_id');
    const ids = r.errors.map((e) => e.id);
    expect(ids).toContain('HALLUCINATED_TABLE');
    const lineItems = r.errors.find(
      (e) => e.id === 'HALLUCINATED_TABLE' && e.metadata?.table === 'line_items',
    );
    expect(lineItems).toBeDefined();
  });

  it('flags an UPDATE on an unknown table', () => {
    const r = v("UPDATE customers SET status='cancelled' WHERE id='1'");
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_TABLE');
  });

  it('flags a DELETE on an unknown table', () => {
    const r = v("DELETE FROM customers WHERE id='1'");
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_TABLE');
  });

  it('suggests a near-match when the typo is close', () => {
    const r = v('SELECT * FROM userz');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_TABLE')!;
    expect(issue.fix).toMatch(/users/);
  });

  it('passes when the table exists', () => {
    const r = v('SELECT id FROM users');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_TABLE')).toBeUndefined();
  });

  it('does not run without a schema (graceful degradation)', () => {
    const r = v('SELECT * FROM customers', null);
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_TABLE')).toBeUndefined();
  });

  it('dedupes when the same unknown table appears twice in one query', () => {
    const r = v('SELECT * FROM customers c1 JOIN customers c2 ON c1.id = c2.parent_id');
    const hits = r.errors.filter((e) => e.id === 'HALLUCINATED_TABLE');
    expect(hits.length).toBe(1);
  });
});

describe('D9: HALLUCINATED_COLUMN', () => {
  it('flags a qualified column that does not exist on the named table', () => {
    const r = v('SELECT u.full_name FROM users u');
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_COLUMN');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')!;
    expect(issue.metadata?.table).toBe('users');
    expect(issue.metadata?.column).toBe('full_name');
  });

  it('suggests a near-match when the typo is close', () => {
    const r = v('SELECT u.frist_name FROM users u');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')!;
    expect(issue.fix).toMatch(/first_name/);
  });

  it('flags a hallucinated column in a WHERE clause', () => {
    const r = v("SELECT u.id FROM users u WHERE u.lifetime_value > 100");
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_COLUMN');
  });

  it('flags a hallucinated column in JOIN ON', () => {
    const r = v('SELECT u.id FROM users u JOIN orders o ON o.customer_id = u.id');
    expect(
      r.errors.find(
        (e) => e.id === 'HALLUCINATED_COLUMN' && e.metadata?.column === 'customer_id',
      ),
    ).toBeDefined();
  });

  it('flags a bare unqualified column when there is exactly one FROM table', () => {
    const r = v('SELECT lifetime_value FROM users');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN');
    expect(issue).toBeDefined();
    expect(issue!.metadata?.table).toBe('users');
    expect(issue!.metadata?.column).toBe('lifetime_value');
  });

  it('does NOT flag bare columns with multi-table FROM (joins still deferred)', () => {
    // With JOINs the resolver can't unambiguously pick a table; v2 work.
    const r = v(
      'SELECT lifetime_value FROM users u JOIN orders o ON o.user_id = u.id',
    );
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('does NOT flag bare columns when a CTE is declared (CTE scope deferred)', () => {
    const r = v('WITH foo AS (SELECT 1 AS x) SELECT lifetime_value FROM users');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('does NOT false-positive when ORDER BY references a SELECT alias', () => {
    const r = v('SELECT id AS user_id FROM users ORDER BY user_id');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('passes a bare unqualified column that exists on the single FROM table', () => {
    const r = v('SELECT email FROM users');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('does NOT flag when the qualifier table is itself unknown (D8 owns that)', () => {
    const r = v('SELECT c.email FROM customers c');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_TABLE');
  });

  it('passes for a fully-qualified column that exists', () => {
    const r = v('SELECT u.first_name, u.last_name FROM users u');
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('does not run without a schema', () => {
    const r = v('SELECT u.full_name FROM users u', null);
    expect(r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')).toBeUndefined();
  });

  it('dedupes repeat references to the same hallucinated column', () => {
    const r = v(
      'SELECT u.full_name FROM users u WHERE u.full_name IS NOT NULL ORDER BY u.full_name',
    );
    const hits = r.errors.filter((e) => e.id === 'HALLUCINATED_COLUMN');
    expect(hits.length).toBe(1);
  });
});

describe('D8 + D9 — risk score is in the error band', () => {
  it('hallucinated table drops score below 50', () => {
    const r = v('SELECT * FROM customers');
    expect(r.riskScore).toBeLessThan(50);
    expect(r.executionSafe).toBe(false);
  });

  it('hallucinated column drops score below 50', () => {
    const r = v('SELECT u.full_name FROM users u');
    expect(r.riskScore).toBeLessThan(50);
    expect(r.executionSafe).toBe(false);
  });
});
