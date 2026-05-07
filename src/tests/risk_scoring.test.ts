import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';

const SCHEMA = parseDDL(`
  CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL, status TEXT, created_at TIMESTAMPTZ);
  CREATE TABLE orders (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id), total_amount NUMERIC(10,2), status TEXT, created_at TIMESTAMPTZ);
  CREATE TABLE order_items (id UUID PRIMARY KEY, order_id UUID REFERENCES orders(id), quantity INTEGER, unit_price NUMERIC(10,2));
  CREATE TABLE payments (id UUID PRIMARY KEY, order_id UUID REFERENCES orders(id), amount NUMERIC(10,2), status TEXT, created_at TIMESTAMPTZ);
`);

const v = (sql: string) => validateSQL({ sql, schema: SCHEMA, dialect: 'postgresql' });

describe('risk scoring — suggestion-band visibility', () => {
  it('a clean query scores exactly 100', () => {
    const r = v('SELECT id, email FROM users');
    expect(r.errors.length).toBe(0);
    expect(r.warnings.length).toBe(0);
    expect(r.suggestions.length).toBe(0);
    expect(r.riskScore).toBe(100);
  });

  it('SELECT * FROM payments — suggestion-only result drops score into 85-95', () => {
    // Regression: previously the score stayed at 100 because suggestions
    // weren't weighed, so users perceived "no issues" and missed D5.
    const r = v('SELECT * FROM payments');
    expect(r.errors.length).toBe(0);
    expect(r.warnings.length).toBe(0);
    expect(r.suggestions.map((s) => s.id)).toContain('SELECT_STAR_EXPENSIVE');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
    expect(r.riskScore).toBeLessThan(100);
  });

  it('suggestions stay in the Safe band (>= 85), never crossing into Review', () => {
    // Stacking suggestions must never demote a clean-of-errors-and-warnings
    // query below the 85 floor.
    const r = v('SELECT * FROM payments');
    for (const s of r.suggestions) expect(s.severity).toBe('suggestion');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });

  it('warnings still dominate suggestions — score drops below 85', () => {
    // 3-way JOIN triggers JOIN_MULTIPLICATION (warning) — must land below 85.
    const r = v(
      'SELECT * FROM users JOIN orders o ON users.id=o.user_id JOIN payments p ON p.order_id=o.id',
    );
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.riskScore).toBeLessThan(85);
  });

  it('errors still dominate everything — score below 41', () => {
    const r = v('DELETE FROM users');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.riskScore).toBeLessThan(41);
  });
});
