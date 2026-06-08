import { describe, expect, it } from 'vitest';
import {
  generateSandboxData,
  sampleColumnValue,
  topologicalSort,
} from '../services/sandboxGenerator';
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

// Semantic column inference (sampleColumnValue) — guards BUG 1 (full_name) and
// BUG 2 (country) plus the audit fixes (company / address / zip / country_code).
const PLACEHOLDER = /^[a-z_]+_\d{3,}$/;

describe('semantic column inference', () => {
  it('full_name → realistic "First Last", never a placeholder', () => {
    for (let s = 1; s <= 20; s++) {
      const r = String(sampleColumnValue('full_name', 'text', s));
      expect(r).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(r).not.toContain('full_name_');
      expect(r).not.toContain('_');
    }
  });

  it('name → realistic value, never a placeholder', () => {
    const r = String(sampleColumnValue('name', 'text', 3));
    expect(r).not.toContain('name_');
    expect(r).not.toMatch(PLACEHOLDER);
  });

  it('country → full country name, never a placeholder or 2-letter code', () => {
    for (let s = 1; s <= 20; s++) {
      const r = String(sampleColumnValue('country', 'text', s));
      expect(r).not.toContain('country_');
      expect(r.length).toBeGreaterThan(2);
      expect(r).not.toMatch(/^[A-Z]{2}$/);
    }
  });

  it('country_code → 2-3 letter ISO code', () => {
    const r = String(sampleColumnValue('country_code', 'text', 5));
    expect(r).toMatch(/^[A-Z]{2,3}$/);
  });

  it('email → valid email format', () => {
    const r = String(sampleColumnValue('email', 'text', 7));
    expect(r).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
  });

  it('company / address / zip no longer emit placeholders', () => {
    expect(String(sampleColumnValue('company', 'text', 2))).not.toMatch(PLACEHOLDER);
    expect(String(sampleColumnValue('address', 'text', 2))).not.toMatch(PLACEHOLDER);
    expect(String(sampleColumnValue('zip', 'text', 2))).toMatch(/^\d{5}$/);
    expect(String(sampleColumnValue('postal_code', 'text', 2))).toMatch(/^\d{5}$/);
  });

  it('no common column generates a placeholder string', () => {
    const cols = ['full_name', 'country', 'country_code', 'email', 'phone', 'city',
      'first_name', 'last_name', 'company', 'address', 'zip'];
    for (const col of cols) {
      const r = String(sampleColumnValue(col, 'text', 11));
      expect(r).not.toMatch(PLACEHOLDER);
    }
  });

  it('state → full US state name, not a status value', () => {
    const statuses = ['active', 'pending', 'completed', 'cancelled', 'inactive', 'trial'];
    for (let s = 1; s <= 20; s++) {
      const r = String(sampleColumnValue('state', 'text', s));
      expect(US_STATES).toContain(r);
      expect(statuses).not.toContain(r);
    }
  });

  it('state_code → 2-letter state code', () => {
    const r = String(sampleColumnValue('state_code', 'text', 4));
    expect(r).toMatch(/^[A-Z]{2}$/);
    expect(STATE_CODES).toContain(r);
  });

  it('status → still returns a status value', () => {
    const statuses = ['active', 'pending', 'completed', 'cancelled', 'inactive'];
    for (let s = 1; s <= 10; s++) {
      expect(statuses).toContain(String(sampleColumnValue('status', 'text', s)));
    }
  });

  it('account_status / order_status → still return status values', () => {
    const statuses = ['active', 'pending', 'completed', 'cancelled', 'inactive'];
    expect(statuses).toContain(String(sampleColumnValue('account_status', 'text', 2)));
    expect(statuses).toContain(String(sampleColumnValue('order_status', 'text', 3)));
  });

  it('state token columns → US state (prefix / suffix / middle token)', () => {
    const stateCols = [
      'state', 'billing_state', 'shipping_state',
      'home_state_name', 'primary_state_id', 'mailing_state_region', 'tri_state_area',
    ];
    for (const col of stateCols) {
      for (let s = 1; s <= 10; s++) {
        expect(US_STATES).toContain(String(sampleColumnValue(col, 'text', s)));
      }
    }
  });

  it('real_estate / estate → NOT a US state (no underscore boundary)', () => {
    for (let s = 1; s <= 10; s++) {
      expect(US_STATES).not.toContain(String(sampleColumnValue('real_estate', 'text', s)));
      expect(US_STATES).not.toContain(String(sampleColumnValue('estate', 'text', s)));
    }
  });
});

// Mirror of the generator's pools so the state tests can assert membership.
const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
  'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
  'Wisconsin', 'Wyoming',
];
const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY',
];
