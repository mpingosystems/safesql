import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition, ValidationReport } from '../types/validation';

// users and orders share: id, status, created_at (ambiguous candidates).
const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, status TEXT, country TEXT, created_at TIMESTAMPTZ);
  CREATE TABLE orders (id UUID PRIMARY KEY, user_id UUID, total_amount NUMERIC, status TEXT, created_at TIMESTAMPTZ);
`);
const v = (sql: string, schema: SchemaDefinition | undefined = SCHEMA): ValidationReport =>
  validateSQL({ sql, schema, dialect: 'postgresql' });
const ids = (r: ValidationReport) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

// ── D34 — AMBIGUOUS column (already shipped as AMBIGUOUS_COLUMN) ──────────────
describe('D34: AMBIGUOUS_UNQUALIFIED_COLUMN (== AMBIGUOUS_COLUMN)', () => {
  it('fires on an unqualified column that exists on both JOIN tables', () => {
    const r = v('SELECT id, status FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).toContain('AMBIGUOUS_COLUMN');
    expect(r.riskScore).toBeLessThan(70);
  });
  it('does NOT fire when columns are qualified', () => {
    const r = v('SELECT u.id, u.status FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).not.toContain('AMBIGUOUS_COLUMN');
  });
  it('does NOT fire on a single-table query', () => {
    expect(ids(v('SELECT id, status FROM users'))).not.toContain('AMBIGUOUS_COLUMN');
  });
  it('does NOT fire when the column exists on only one of the JOIN tables', () => {
    // total_amount is on orders only → resolvable, not ambiguous.
    const r = v('SELECT total_amount FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).not.toContain('AMBIGUOUS_COLUMN');
  });
});

// ── D35 — UNKNOWN_ALIAS (+ did-you-mean enhancement) ─────────────────────────
describe('D35: UNKNOWN_ALIAS', () => {
  it('fires on an undefined alias and scores below 50', () => {
    const r = v('SELECT x.email FROM users u');
    expect(ids(r)).toContain('UNKNOWN_ALIAS');
    expect(r.riskScore).toBeLessThan(50);
  });
  it('includes a "Did you mean?" suggestion for a near alias (x → u)', () => {
    const r = v('SELECT u.email, z.email FROM users u');
    const issue = r.errors.find((e) => e.id === 'UNKNOWN_ALIAS')!;
    expect(issue.fix).toMatch(/Did you mean u/);
    expect(issue.metadata?.suggestion).toBe('u');
  });
  it('does NOT flag a defined alias', () => {
    expect(ids(v('SELECT u.email FROM users u'))).not.toContain('UNKNOWN_ALIAS');
  });
  it('does NOT flag a subquery alias', () => {
    const r = v('SELECT sub.n FROM (SELECT 1 AS n) sub', undefined);
    expect(ids(r)).not.toContain('UNKNOWN_ALIAS');
  });
});

// ── D36 — UNQUALIFIED_COLUMN_RESOLVER (multi-table bare columns) ──────────────
describe('D36: unqualified column resolver', () => {
  it('flags a bare column on no table (multi-table FROM)', () => {
    const r = v('SELECT lifetime_value FROM users u JOIN orders o ON o.user_id = u.id');
    const issue = r.errors.find((e) => e.id === 'HALLUCINATED_COLUMN')!;
    expect(issue).toBeDefined();
    expect(issue.offendingColumn).toBe('lifetime_value');
    expect(r.riskScore).toBeLessThan(50);
  });
  it('does NOT flag a bare column that exists on one of the tables', () => {
    const r = v('SELECT total_amount FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).not.toContain('HALLUCINATED_COLUMN');
  });
  it('does NOT flag SELECT * (star is valid)', () => {
    const r = v('SELECT * FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).not.toContain('HALLUCINATED_COLUMN');
  });
  it('does NOT double-fire with D34 on an ambiguous column', () => {
    // `status` exists on both → AMBIGUOUS_COLUMN, NOT HALLUCINATED_COLUMN.
    const r = v('SELECT status FROM users u JOIN orders o ON o.user_id = u.id');
    expect(ids(r)).toContain('AMBIGUOUS_COLUMN');
    expect(ids(r)).not.toContain('HALLUCINATED_COLUMN');
  });
});
