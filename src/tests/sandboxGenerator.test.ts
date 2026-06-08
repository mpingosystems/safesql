import { describe, expect, it } from 'vitest';
import { generateSandboxData, topologicalSort } from '../services/sandboxGenerator';
import { parseDDL } from '../services/schemaParser';

const DDL = `
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    status TEXT CHECK (status IN ('active','inactive','trial')),
    created_at TIMESTAMPTZ
  );
  CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2) NOT NULL,
    status TEXT CHECK (status IN ('pending','shipped','delivered'))
  );
  CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    price NUMERIC(10,2) NOT NULL
  );
  CREATE TABLE payments (
    id UUID PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    amount NUMERIC(10,2) NOT NULL
  );
`;

const schema = parseDDL(DDL);

// Parse the INSERT statements back into per-table rows of raw value strings.
function rowsFor(statements: string[], table: string): string[][] {
  const re = new RegExp(`^INSERT INTO "${table}" \\(([^)]*)\\) VALUES \\((.*)\\);$`);
  const out: string[][] = [];
  for (const s of statements) {
    const m = re.exec(s);
    if (m) out.push(splitValues(m[2]));
  }
  return out;
}
function colsFor(statements: string[], table: string): string[] {
  const re = new RegExp(`^INSERT INTO "${table}" \\(([^)]*)\\) VALUES`);
  for (const s of statements) {
    const m = re.exec(s);
    if (m) return m[1].split(',').map((c) => c.trim().replace(/"/g, ''));
  }
  return [];
}
// Split a VALUES tuple on top-level commas (values here have no nested commas
// except inside quoted strings, which our generated data avoids).
function splitValues(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" ) inStr = !inStr;
    if (ch === ',' && !inStr) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const unquote = (v: string) => v.replace(/^'|'$/g, '').replace(/''/g, "'");

describe('generateSandboxData', () => {
  const stmts = generateSandboxData(schema, { rowsPerTable: 100, seed: 42 });

  it('status column with CHECK only generates allowed values', () => {
    const cols = colsFor(stmts, 'users');
    const statusIdx = cols.indexOf('status');
    for (const row of rowsFor(stmts, 'users')) {
      expect(['active', 'inactive', 'trial']).toContain(unquote(row[statusIdx]));
    }
  });

  it('email columns contain @', () => {
    const cols = colsFor(stmts, 'users');
    const idx = cols.indexOf('email');
    for (const row of rowsFor(stmts, 'users')) {
      expect(unquote(row[idx])).toContain('@');
    }
  });

  it('full_name columns contain a space (real names, not full_name_3367)', () => {
    const cols = colsFor(stmts, 'users');
    const idx = cols.indexOf('full_name');
    for (const row of rowsFor(stmts, 'users')) {
      const name = unquote(row[idx]);
      expect(name).toMatch(/\S+ \S+/);
      expect(name).not.toMatch(/full_name_\d+/);
    }
  });

  it('FK rows reference valid parent IDs', () => {
    const userCols = colsFor(stmts, 'users');
    const userIdIdx = userCols.indexOf('id');
    const userIds = new Set(rowsFor(stmts, 'users').map((r) => unquote(r[userIdIdx])));

    const orderCols = colsFor(stmts, 'orders');
    const fkIdx = orderCols.indexOf('user_id');
    for (const row of rowsFor(stmts, 'orders')) {
      expect(userIds.has(unquote(row[fkIdx]))).toBe(true);
    }
  });

  it('no NULL appears in NOT NULL columns', () => {
    // email, full_name (users) and total_amount (orders) are NOT NULL.
    const uCols = colsFor(stmts, 'users');
    for (const row of rowsFor(stmts, 'users')) {
      expect(row[uCols.indexOf('email')]).not.toBe('NULL');
      expect(row[uCols.indexOf('full_name')]).not.toBe('NULL');
    }
    const oCols = colsFor(stmts, 'orders');
    for (const row of rowsFor(stmts, 'orders')) {
      expect(row[oCols.indexOf('total_amount')]).not.toBe('NULL');
    }
  });

  it('PK values are unique across all rows', () => {
    for (const table of ['users', 'orders', 'order_items', 'payments']) {
      const cols = colsFor(stmts, table);
      const idIdx = cols.indexOf('id');
      const ids = rowsFor(stmts, table).map((r) => r[idIdx]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('INTEGER PK is sequential (1,2,3…)', () => {
    const cols = colsFor(stmts, 'orders');
    const idIdx = cols.indexOf('id');
    const ids = rowsFor(stmts, 'orders').map((r) => Number(r[idIdx]));
    expect(ids.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('topological order: parent rows are inserted before child inserts', () => {
    const firstIndexOf = (table: string) =>
      stmts.findIndex((s) => s.startsWith(`INSERT INTO "${table}"`));
    expect(firstIndexOf('users')).toBeLessThan(firstIndexOf('orders'));
    expect(firstIndexOf('orders')).toBeLessThan(firstIndexOf('order_items'));
    expect(firstIndexOf('orders')).toBeLessThan(firstIndexOf('payments'));
  });

  it('generates 4 tables × 100 rows in < 500ms', () => {
    const start = performance.now();
    const out = generateSandboxData(schema, { rowsPerTable: 100, seed: 7 });
    const elapsed = performance.now() - start;
    expect(out.length).toBe(400);
    expect(elapsed).toBeLessThan(500);
  });

  it('per-table row-count override is honored', () => {
    const out = generateSandboxData(schema, { rowsPerTable: { users: 5, orders: 8 } });
    expect(rowsFor(out, 'users').length).toBe(5);
    expect(rowsFor(out, 'orders').length).toBe(8);
    expect(rowsFor(out, 'order_items').length).toBe(100); // default
  });
});

describe('topologicalSort', () => {
  it('orders parents before children', () => {
    const order = topologicalSort(schema.tables).map((t) => t.name);
    expect(order.indexOf('users')).toBeLessThan(order.indexOf('orders'));
    expect(order.indexOf('orders')).toBeLessThan(order.indexOf('order_items'));
  });
});
