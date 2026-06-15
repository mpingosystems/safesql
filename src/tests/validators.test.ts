import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition } from '../types/validation';

const ECOMMERCE_SCHEMA: SchemaDefinition = parseDDL(`
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
`);

const NULLABLE_FK_SCHEMA: SchemaDefinition = {
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'UUID', nullable: false, isPK: true, isFK: false },
        { name: 'user_id', type: 'UUID', nullable: true, isPK: false, isFK: true },
        { name: 'amount', type: 'NUMERIC', nullable: false, isPK: false, isFK: false },
      ],
    },
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'UUID', nullable: false, isPK: true, isFK: false },
        { name: 'email', type: 'TEXT', nullable: false, isPK: false, isFK: false },
      ],
    },
  ],
};

const v = (sql: string, schema?: SchemaDefinition) =>
  validateSQL({ sql, schema, dialect: 'postgresql' });

describe('D2: MISSING_WHERE_DESTRUCTIVE', () => {
  it('flags DELETE without WHERE', () => {
    const r = v('DELETE FROM users');
    expect(r.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
  });

  it('flags UPDATE without WHERE', () => {
    const r = v("UPDATE users SET email = 'x@y.com'");
    expect(r.errors.map((e) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
  });

  it('passes DELETE with WHERE', () => {
    const r = v("DELETE FROM users WHERE id = '123'");
    expect(r.errors.find((e) => e.id === 'MISSING_WHERE_DESTRUCTIVE')).toBeUndefined();
  });
});

describe('D3: INCOMPLETE_GROUP_BY', () => {
  it('flags non-aggregated column missing from GROUP BY', () => {
    const r = v('SELECT user_id, SUM(amount) FROM orders');
    expect(r.errors.map((e) => e.id)).toContain('INCOMPLETE_GROUP_BY');
  });

  it('passes when GROUP BY covers non-aggregated columns', () => {
    const r = v('SELECT user_id, SUM(amount) FROM orders GROUP BY user_id');
    expect(r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')).toBeUndefined();
  });

  it('passes when no aggregation present', () => {
    const r = v('SELECT user_id, amount FROM orders');
    expect(r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')).toBeUndefined();
  });

  it('passes when a selected expression is grouped by the same expression (no alias false positive)', () => {
    const r = v("SELECT DATE_TRUNC('month', paid_at) AS month, SUM(amount) FROM payments GROUP BY DATE_TRUNC('month', paid_at)");
    expect(r.errors.find((e) => e.id === 'INCOMPLETE_GROUP_BY')).toBeUndefined();
  });
});

describe('D4: CONTRADICTORY_FILTER', () => {
  it('flags AND of two equality conditions on same column with different values', () => {
    const r = v("SELECT * FROM orders WHERE status = 'active' AND status = 'inactive'");
    expect(r.errors.map((e) => e.id)).toContain('CONTRADICTORY_FILTER');
  });

  it('does NOT flag OR of two equalities on same column', () => {
    const r = v("SELECT * FROM orders WHERE status = 'active' OR status = 'inactive'");
    expect(r.errors.find((e) => e.id === 'CONTRADICTORY_FILTER')).toBeUndefined();
  });

  it('passes single equality', () => {
    const r = v("SELECT * FROM orders WHERE status = 'active'");
    expect(r.errors.find((e) => e.id === 'CONTRADICTORY_FILTER')).toBeUndefined();
  });
});

describe('D1: JOIN_MULTIPLICATION', () => {
  it('flags JOIN to many-side without GROUP BY/aggregate', () => {
    const r = v(
      'SELECT * FROM orders o JOIN order_items oi ON o.id = oi.order_id',
      ECOMMERCE_SCHEMA,
    );
    expect(r.warnings.map((w) => w.id)).toContain('JOIN_MULTIPLICATION');
  });

  it('passes when GROUP BY collapses the join', () => {
    const r = v(
      `SELECT o.user_id, SUM(oi.price)
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       GROUP BY o.user_id`,
      ECOMMERCE_SCHEMA,
    );
    expect(r.warnings.find((w) => w.id === 'JOIN_MULTIPLICATION')).toBeUndefined();
  });
});

describe('D5: SELECT_STAR_EXPENSIVE', () => {
  it('flags SELECT * on columnar-name table as warning', () => {
    const r = v('SELECT * FROM transactions');
    const allIssues = [...r.warnings, ...r.suggestions];
    const hit = allIssues.find((i) => i.id === 'SELECT_STAR_EXPENSIVE');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
  });

  it('flags SELECT * on small unknown table as suggestion', () => {
    const r = v('SELECT * FROM tiny_table');
    expect(r.suggestions.map((s) => s.id)).toContain('SELECT_STAR_EXPENSIVE');
  });
});

describe('D6: INNER_JOIN_NULL_EXCLUSION', () => {
  it('flags INNER JOIN on nullable FK', () => {
    const r = v(
      'SELECT * FROM orders o INNER JOIN users u ON o.user_id = u.id',
      NULLABLE_FK_SCHEMA,
    );
    expect(r.warnings.map((w) => w.id)).toContain('INNER_JOIN_NULL_EXCLUSION');
  });
});

describe('D7: AGGREGATION_GRAIN_MISMATCH', () => {
  it('flags aggregate across JOIN without GROUP BY', () => {
    const r = v(
      'SELECT SUM(oi.price) FROM orders o JOIN order_items oi ON o.id = oi.order_id',
      ECOMMERCE_SCHEMA,
    );
    expect(r.warnings.map((w) => w.id)).toContain('AGGREGATION_GRAIN_MISMATCH');
  });

  it('passes when GROUP BY is present', () => {
    const r = v(
      `SELECT o.user_id, SUM(oi.price)
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       GROUP BY o.user_id`,
      ECOMMERCE_SCHEMA,
    );
    expect(r.warnings.find((w) => w.id === 'AGGREGATION_GRAIN_MISMATCH')).toBeUndefined();
  });
});

describe('Architecture invariants', () => {
  it('clean SQL gets riskScore 100', () => {
    const r = v('SELECT id, email FROM users WHERE id = 1');
    expect(r.riskScore).toBe(100);
    expect(r.executionSafe).toBe(true);
  });

  it('any error makes executionSafe = false', () => {
    const r = v('DELETE FROM users');
    expect(r.executionSafe).toBe(false);
  });

  it('syntax error short-circuits to riskScore 0', () => {
    const r = v('SELEKT BROKEN SQL');
    expect(r.riskScore).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
