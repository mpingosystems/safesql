import { describe, it, expect } from 'vitest';
import { buildFanoutProofQuery } from '../services/fanoutProof';
import { parseDDL } from '../services/schemaParser';

const DDL = `CREATE TABLE customers (id UUID PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE subscriptions (id UUID PRIMARY KEY, customer_id UUID REFERENCES customers(id), amount NUMERIC(10,2));
CREATE TABLE payments (id UUID PRIMARY KEY, customer_id UUID REFERENCES customers(id), amount NUMERIC(10,2), status TEXT);`;

const GROUPED =
  "SELECT c.id, SUM(p.amount) AS total FROM customers c JOIN subscriptions s ON s.customer_id = c.id JOIN payments p ON p.customer_id = c.id WHERE p.status = 'succeeded' GROUP BY c.id ORDER BY total DESC";

describe('buildFanoutProofQuery', () => {
  const schema = parseDDL(DDL);

  it('identifies the fact table from SUM and builds a COUNT/COUNT-DISTINCT query', () => {
    const proof = buildFanoutProofQuery(GROUPED, schema, 'postgresql');
    expect(proof).not.toBeNull();
    expect(proof!.factTable.toLowerCase()).toBe('payments');
    expect(proof!.countQuery).toMatch(/COUNT\(\*\)/i);
    expect(proof!.countQuery).toMatch(/COUNT\(DISTINCT/i);
    // FROM/JOIN/WHERE preserved; aggregating clauses stripped.
    expect(proof!.countQuery).toMatch(/JOIN/i);
    expect(proof!.countQuery).not.toMatch(/GROUP\s+BY/i);
    expect(proof!.countQuery).not.toMatch(/ORDER\s+BY/i);
  });

  it('returns null for a single-table query (no fan-out possible)', () => {
    expect(buildFanoutProofQuery('SELECT SUM(amount) FROM payments', schema, 'postgresql')).toBeNull();
  });

  it('returns null when there is no value aggregate over a qualified column', () => {
    const sql = 'SELECT c.id FROM customers c JOIN payments p ON p.customer_id = c.id';
    expect(buildFanoutProofQuery(sql, schema, 'postgresql')).toBeNull();
  });
});
