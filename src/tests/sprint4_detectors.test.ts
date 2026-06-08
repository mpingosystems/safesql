import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition, ValidationReport } from '../types/validation';

const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL, status TEXT);
  CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2),
    status TEXT
  );
  CREATE TABLE metrics (
    id UUID PRIMARY KEY,
    completed INTEGER NOT NULL,
    total INTEGER NOT NULL,
    active_users INTEGER
  );
  CREATE TABLE payments (id UUID PRIMARY KEY, amount NUMERIC(10,2));
  CREATE TABLE transactions (id UUID PRIMARY KEY, amount NUMERIC(10,2));
`);

const v = (sql: string, schema: SchemaDefinition | undefined = SCHEMA): ValidationReport =>
  validateSQL({ sql, schema, dialect: 'postgresql' });
const ids = (r: ValidationReport) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

// ── D5 fix verification (was fixed in Sprint 3; lock it in) ───────────────────
describe('D5: SELECT_STAR_EXPENSIVE fires', () => {
  it('SELECT * FROM payments → suggestion, score 85-95', () => {
    const r = v('SELECT * FROM payments');
    expect(ids(r)).toContain('SELECT_STAR_EXPENSIVE');
    expect(r.suggestions.map((s) => s.id)).toContain('SELECT_STAR_EXPENSIVE');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
    expect(r.riskScore).toBeLessThan(100);
  });

  it('SELECT id, amount FROM payments → no D5', () => {
    const r = v('SELECT id, amount FROM payments');
    expect(ids(r)).not.toContain('SELECT_STAR_EXPENSIVE');
  });

  it('SELECT * FROM transactions → warning (columnar-name table)', () => {
    const r = v('SELECT * FROM transactions');
    const hit = [...r.warnings, ...r.suggestions].find((i) => i.id === 'SELECT_STAR_EXPENSIVE');
    expect(hit?.severity).toBe('warning');
  });
});

// ── D13: INTEGER_DIVISION_RISK (schema-aware) ────────────────────────────────
describe('D13: INTEGER_DIVISION_RISK', () => {
  it('fires on COUNT(x) / COUNT(*)', () => {
    const r = v('SELECT COUNT(active_users) / COUNT(*) AS ratio FROM metrics');
    expect(ids(r)).toContain('INTEGER_DIVISION_RISK');
  });

  it('fires on integer-column / integer-column (completed / total)', () => {
    const r = v('SELECT completed / total AS rate FROM metrics');
    expect(ids(r)).toContain('INTEGER_DIVISION_RISK');
  });

  it('does NOT fire when the numerator is already cast', () => {
    const r = v('SELECT CAST(completed AS DECIMAL) / total AS rate FROM metrics');
    expect(ids(r)).not.toContain('INTEGER_DIVISION_RISK');
  });

  it('does NOT fire on numeric / integer division (no truncation risk)', () => {
    const r = v('SELECT total_amount / 2 AS half FROM orders');
    expect(ids(r)).not.toContain('INTEGER_DIVISION_RISK');
  });
});

// ── D14: COUNT_STAR_VS_COUNT_COL ─────────────────────────────────────────────
describe('D14: COUNT_STAR_VS_COUNT_COL', () => {
  it('fires on COUNT(nullable_col)', () => {
    const r = v('SELECT COUNT(user_id) FROM orders');
    expect(ids(r)).toContain('COUNT_STAR_VS_COUNT_COL');
    expect(r.suggestions.find((s) => s.id === 'COUNT_STAR_VS_COUNT_COL')!.offendingColumn).toBe('user_id');
  });

  it('does NOT fire on COUNT(*)', () => {
    const r = v('SELECT COUNT(*) FROM orders');
    expect(ids(r)).not.toContain('COUNT_STAR_VS_COUNT_COL');
  });

  it('does NOT fire on COUNT(NOT NULL pk column)', () => {
    const r = v('SELECT COUNT(id) FROM orders');
    expect(ids(r)).not.toContain('COUNT_STAR_VS_COUNT_COL');
  });

  it('does NOT fire on COUNT(DISTINCT col) — deliberate', () => {
    const r = v('SELECT COUNT(DISTINCT user_id) FROM orders');
    expect(ids(r)).not.toContain('COUNT_STAR_VS_COUNT_COL');
  });
});

// ── D15: HAVING_WITHOUT_GROUP_BY ─────────────────────────────────────────────
describe('D15: HAVING_WITHOUT_GROUP_BY', () => {
  it('fires on HAVING with no GROUP BY', () => {
    const r = v('SELECT COUNT(*) FROM orders HAVING COUNT(*) > 100');
    expect(ids(r)).toContain('HAVING_WITHOUT_GROUP_BY');
    expect(r.errors.find((e) => e.id === 'HAVING_WITHOUT_GROUP_BY')).toBeDefined();
    expect(r.riskScore).toBeLessThan(50);
  });

  it('does NOT fire when GROUP BY is present', () => {
    const r = v('SELECT user_id, COUNT(*) FROM orders GROUP BY user_id HAVING COUNT(*) > 5');
    expect(ids(r)).not.toContain('HAVING_WITHOUT_GROUP_BY');
  });

  it('does NOT fire when there is no HAVING at all', () => {
    const r = v('SELECT user_id, COUNT(*) FROM orders GROUP BY user_id');
    expect(ids(r)).not.toContain('HAVING_WITHOUT_GROUP_BY');
  });
});
