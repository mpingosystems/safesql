import { describe, expect, it } from 'vitest';
import { locateIssue } from '../services/issueLocator';
import type { ValidationIssue } from '../types/validation';

const base: ValidationIssue = {
  id: 'LEFT_JOIN_FILTERED_IN_WHERE',
  severity: 'warning',
  title: 't',
  description: 'd',
};

describe('locateIssue', () => {
  it('anchors a qualified column reference', () => {
    const sql = 'SELECT u.id\nFROM users u\nWHERE o.status = 1';
    const r = locateIssue(sql, { ...base, offendingTable: 'orders', offendingColumn: 'status' })!;
    expect(r).not.toBeNull();
    expect(r.startLineNumber).toBe(3);
    // column "o.status" begins at column 7 on the WHERE line ("WHERE o.status")
    expect(r.startColumn).toBe(7);
  });

  it('falls back to a bare column when no qualified hit exists', () => {
    const sql = 'SELECT lifetime_value FROM users';
    const r = locateIssue(sql, {
      ...base,
      id: 'HALLUCINATED_COLUMN',
      offendingTable: 'users',
      offendingColumn: 'lifetime_value',
    })!;
    expect(r.startLineNumber).toBe(1);
    expect(r.startColumn).toBe(8);
  });

  it('anchors a table when only a table is given', () => {
    const sql = 'SELECT * FROM customer_orders';
    const r = locateIssue(sql, {
      ...base,
      id: 'HALLUCINATED_TABLE',
      offendingTable: 'customer_orders',
    })!;
    expect(r.startColumn).toBe(15);
  });

  it('anchors a clause keyword when no table/column is given', () => {
    const sql = 'SELECT a / b AS r FROM t';
    const r = locateIssue(sql, { ...base, id: 'INTEGER_DIVISION_RISK', offendingClause: 'SELECT' })!;
    expect(r.startLineNumber).toBe(1);
    expect(r.startColumn).toBe(1);
  });

  it('returns null when nothing can be located', () => {
    const sql = 'SELECT 1';
    expect(locateIssue(sql, base)).toBeNull();
  });
});
