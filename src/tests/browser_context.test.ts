import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';

// Browser-context regression: reproduces EXACTLY what production does —
// the user pastes 3 CREATE TABLEs into the schema panel (parsed via parseDDL,
// the same path SchemaPanel uses) including `user_tags`, then validates. These
// two queries were reported scoring 100 / 65 in the browser while passing in
// the unit tests, because the earlier unit tests used a partial / null schema
// and never exercised the 3-table-with-user_tags shape the browser sends.
const PROD_DDL = `
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    country TEXT
  );
  CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2),
    status TEXT
  );
  CREATE TABLE user_tags (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    tag TEXT
  );
`;

const SCHEMA = parseDDL(PROD_DDL);

const v = (sql: string) => validateSQL({ sql, schema: SCHEMA, dialect: 'postgresql' });
const ids = (r: ReturnType<typeof v>) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

describe('browser-context regression (3-table schema incl. user_tags)', () => {
  it('parses all three tables with visible FKs', () => {
    expect(SCHEMA.tables.map((t) => t.name).sort()).toEqual(['orders', 'user_tags', 'users']);
    const ordersFk = SCHEMA.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'user_id')!;
    expect(ordersFk.isFK).toBe(true);
  });

  // BUG 1
  it('LEFT_JOIN_FILTERED_IN_WHERE fires and score drops below 70', () => {
    const r = v(
      "SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE o.status = 'completed' GROUP BY u.id",
    );
    expect(ids(r)).toContain('LEFT_JOIN_FILTERED_IN_WHERE');
    expect(r.riskScore).toBeLessThan(70);
    expect(r.riskScore).not.toBe(100);
  });

  // BUG 2
  it('AGGREGATE_OVER_FANOUT_JOIN fires alongside INNER_JOIN_NULL_EXCLUSION', () => {
    const r = v(
      'SELECT u.country, SUM(o.total_amount) FROM users u JOIN orders o ON o.user_id = u.id JOIN user_tags t ON t.user_id = u.id GROUP BY u.country',
    );
    expect(ids(r)).toContain('AGGREGATE_OVER_FANOUT_JOIN');
    // The pre-existing D6 finding is correct but insufficient — both must appear.
    expect(ids(r)).toContain('INNER_JOIN_NULL_EXCLUSION');
    expect(r.riskScore).toBeLessThan(70);
  });
});
