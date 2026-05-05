import { describe, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition } from '../types/validation';

const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL, status TEXT, created_at TIMESTAMPTZ);
  CREATE TABLE orders (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id), total_amount NUMERIC(10,2), status TEXT, created_at TIMESTAMPTZ);
  CREATE TABLE order_items (id UUID PRIMARY KEY, order_id UUID REFERENCES orders(id), quantity INTEGER, unit_price NUMERIC(10,2));
  CREATE TABLE payments (id UUID PRIMARY KEY, order_id UUID REFERENCES orders(id), amount NUMERIC(10,2), status TEXT, created_at TIMESTAMPTZ);
`);

const cases: Array<[string, string]> = [
  ['T1', 'DELETE FROM users'],
  ['T2', "UPDATE orders SET status='cancelled'"],
  ['T3', 'SELECT user_id, SUM(total_amount) FROM orders'],
  ['T4', "SELECT * FROM users WHERE status='active' AND status='inactive'"],
  ['T5', 'SELECT * FROM users JOIN orders o ON users.id=o.user_id JOIN payments p ON p.order_id=o.id'],
  ['T6', 'SELECT * FROM payments'],
  ['T7', 'SELECT user_id, SUM(total_amount) FROM orders GROUP BY user_id'],
  ['T8', "DELETE FROM users WHERE status='inactive'"],
];

describe('dump', () => {
  it('prints per-test results', () => {
    for (const [tag, sql] of cases) {
      const r = validateSQL({ sql, schema: SCHEMA, dialect: 'postgresql' });
      const lines: string[] = [];
      lines.push(`\n=== ${tag} :: ${sql}`);
      lines.push(`riskScore=${r.riskScore} executionSafe=${r.executionSafe} processingMs=${r.processingMs.toFixed(2)}`);
      for (const e of r.errors) lines.push(`  ERROR ${e.id}: ${e.title} | desc=${e.description} | fix=${e.fix ?? '<none>'}`);
      for (const w of r.warnings) lines.push(`  WARN  ${w.id}: ${w.title} | desc=${w.description} | fix=${w.fix ?? '<none>'}`);
      for (const s of r.suggestions) lines.push(`  SUGG  ${s.id}: ${s.title} | desc=${s.description} | fix=${s.fix ?? '<none>'}`);
      console.log(lines.join('\n'));
    }
  });
});
