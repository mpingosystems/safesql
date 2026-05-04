import { describe, expect, it } from 'vitest';
import { parseDDL } from '../services/schemaParser';
import { runSandbox } from '../services/sandboxRunner';

const ECOMMERCE_DDL = `
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  price NUMERIC NOT NULL
);
`;

describe('sandboxRunner — ground-truth row count', () => {
  const schema = parseDDL(ECOMMERCE_DDL);

  it('Postgres rejects SELECT u.id, SUM(o.amount) without GROUP BY', async () => {
    // Even when SafeSQL's static D3 rule passes (e.g., when the SELECT clause
    // doesn't trip the heuristic), the sandbox catches it because Postgres
    // itself refuses to execute. This is the ground-truth promise.
    const sql = `
      SELECT u.id, SUM(o.amount) AS total
      FROM users u
      JOIN orders o ON u.id = o.user_id
    `;
    const result = await runSandbox({
      ddl: ECOMMERCE_DDL,
      sql,
      schema,
      rowsPerTable: 30,
      seed: 42,
    });
    expect(result.executionError).toBeDefined();
    expect(result.executionError).toMatch(/group by/i);
    expect(result.totalRows).toBe(0);
  }, 60_000);

  it('correct GROUP BY query executes and returns ≤ user count rows', async () => {
    const sql = `
      SELECT o.user_id, SUM(oi.price) AS total
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.user_id
    `;
    const result = await runSandbox({
      ddl: ECOMMERCE_DDL,
      sql,
      schema,
      rowsPerTable: { users: 50, orders: 80, order_items: 200 },
      expectedRows: 50,
      seed: 42,
    });
    expect(result.executionError).toBeUndefined();
    expect(result.totalRows).toBeGreaterThan(0);
    expect(result.totalRows).toBeLessThanOrEqual(50);
    expect(result.rowCountFlag?.message).toMatch(/ratio/i);
  }, 60_000);

  it('JOIN multiplication shows inflation when child tables are larger', async () => {
    // 20 users × 60 orders × 200 order_items
    // SELECT * with chained JOINs returns roughly order_items.length rows
    // (1 row per leaf), which far exceeds the user-count expectation.
    const sql = `
      SELECT u.id, oi.price
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN order_items oi ON o.id = oi.order_id
    `;
    const result = await runSandbox({
      ddl: ECOMMERCE_DDL,
      sql,
      schema,
      rowsPerTable: { users: 20, orders: 60, order_items: 200 },
      expectedRows: 20, // user expected one row per user
      seed: 42,
    });
    expect(result.executionError).toBeUndefined();
    expect(result.totalRows).toBeGreaterThan(20);
    expect(result.rowCountFlag).toBeDefined();
    expect(result.rowCountFlag!.ratio).toBeGreaterThan(1);
    expect(result.rowCountFlag!.message).toMatch(/multiplication|inflation/i);
  }, 60_000);
});
