import { describe, it, expect } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition } from '../types/validation';

const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
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
  CREATE TABLE order_items (
    id UUID PRIMARY KEY,
    order_id UUID REFERENCES orders(id),
    quantity INTEGER,
    unit_price NUMERIC(10,2)
  );
  CREATE TABLE payments (
    id UUID PRIMARY KEY,
    order_id UUID REFERENCES orders(id),
    amount NUMERIC(10,2),
    status TEXT,
    created_at TIMESTAMPTZ
  );
`);

const v = (sql: string) => validateSQL({ sql, schema: SCHEMA, dialect: 'postgresql' });

describe('Sprint-2 final validation report', () => {
  it('schema parses 4 tables', () => {
    expect(SCHEMA.tables.map((t) => t.name).sort()).toEqual(
      ['order_items', 'orders', 'payments', 'users'],
    );
  });

  it('T1 DELETE FROM users → D2 error', () => {
    const r = v('DELETE FROM users');
    expect(r.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
    expect(r.executionSafe).toBe(false);
    expect(r.riskScore).toBeLessThan(50);
    const issue = r.errors.find((e) => e.id === 'MISSING_WHERE_DESTRUCTIVE')!;
    expect(issue.description).toBeTruthy();
    expect(issue.fix).toBeTruthy();
  });

  it("T2 UPDATE orders SET status='cancelled' → D2 error", () => {
    const r = v("UPDATE orders SET status='cancelled'");
    expect(r.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
    expect(r.executionSafe).toBe(false);
    expect(r.riskScore).toBeLessThan(50);
    const issue = r.errors.find((e) => e.id === 'MISSING_WHERE_DESTRUCTIVE')!;
    expect(issue.description).toMatch(/WHERE/i);
    expect(issue.fix).toMatch(/WHERE/i);
  });

  it('T3 SELECT user_id, SUM(total_amount) FROM orders → D3 error', () => {
    const r = v('SELECT user_id, SUM(total_amount) FROM orders');
    expect(r.errors.map((e) => e.id)).toContain('INCOMPLETE_GROUP_BY');
    expect(r.riskScore).toBeLessThan(50);
    const issue = r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')!;
    expect(issue.description).toMatch(/GROUP BY/i);
    expect(issue.fix).toMatch(/GROUP BY/i);
  });

  it("T4 contradictory filter (status=active AND status=inactive) → D4 error", () => {
    const r = v("SELECT * FROM users WHERE status='active' AND status='inactive'");
    expect(r.errors.map((e) => e.id)).toContain('CONTRADICTORY_FILTER');
    expect(r.riskScore).toBeLessThan(50);
    const issue = r.errors.find((e) => e.id === 'CONTRADICTORY_FILTER')!;
    expect(issue.description).toMatch(/status/);
    expect(issue.fix).toMatch(/OR/);
  });

  it('T5 3-way JOIN users-orders-payments → D1 warning', () => {
    const r = v(
      'SELECT * FROM users JOIN orders o ON users.id=o.user_id JOIN payments p ON p.order_id=o.id',
    );
    const allIssueIds = [
      ...r.errors.map((i) => i.id),
      ...r.warnings.map((i) => i.id),
      ...r.suggestions.map((i) => i.id),
    ];
    expect(allIssueIds).toContain('JOIN_MULTIPLICATION');
    const issue = r.warnings.find((w) => w.id === 'JOIN_MULTIPLICATION')!;
    expect(issue).toBeDefined();
    expect(issue.description).toBeTruthy();
    expect(issue.fix).toBeTruthy();
    expect(issue.fix).toMatch(/pre-aggregate|GROUP BY|DISTINCT/i);
  });

  it('T6 SELECT * FROM payments → D5 suggestion or warning', () => {
    const r = v('SELECT * FROM payments');
    const allIssues = [...r.warnings, ...r.suggestions];
    const hit = allIssues.find((i) => i.id === 'SELECT_STAR_EXPENSIVE');
    expect(hit).toBeDefined();
    expect(hit!.description).toBeTruthy();
    expect(hit!.fix).toBeTruthy();
  });

  it('T7 clean grouped aggregation → no errors, score ≥85', () => {
    const r = v('SELECT user_id, SUM(total_amount) FROM orders GROUP BY user_id');
    expect(r.errors.length).toBe(0);
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
    expect(r.executionSafe).toBe(true);
  });

  it("T8 DELETE FROM users WHERE status='inactive' → no errors, score ≥85", () => {
    const r = v("DELETE FROM users WHERE status='inactive'");
    expect(r.errors.length).toBe(0);
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
    expect(r.executionSafe).toBe(true);
  });

  it('Fixed versions of bad queries score higher than originals', () => {
    const t3orig = v('SELECT user_id, SUM(total_amount) FROM orders');
    const t3fix = v('SELECT user_id, SUM(total_amount) FROM orders GROUP BY user_id');
    expect(t3fix.riskScore).toBeGreaterThan(t3orig.riskScore);

    const t1orig = v('DELETE FROM users');
    const t1fix = v("DELETE FROM users WHERE status='inactive'");
    expect(t1fix.riskScore).toBeGreaterThan(t1orig.riskScore);
  });
});
