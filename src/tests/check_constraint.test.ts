import { describe, expect, it } from 'vitest';
import { parseDDL, extractCheckEnums } from '../services/schemaParser';
import { runSandbox, resetSandboxState } from '../services/sandboxRunner';

describe('extractCheckEnums', () => {
  it('extracts a simple CHECK IN list', () => {
    const got = extractCheckEnums(
      "CREATE TABLE users (status TEXT CHECK (status IN ('active','inactive','trial')));",
    );
    expect(got.get('status')).toEqual(['active', 'inactive', 'trial']);
  });

  it('handles whitespace and double-quoted column ident', () => {
    const got = extractCheckEnums(
      `CREATE TABLE t (
         "kind" TEXT CHECK ( "kind"  IN  ( 'a' , 'b' ) )
       );`,
    );
    expect(got.get('kind')).toEqual(['a', 'b']);
  });

  it('handles escaped single-quotes inside enum values', () => {
    const got = extractCheckEnums(
      "CREATE TABLE t (label TEXT CHECK (label IN ('it''s','plain')));",
    );
    expect(got.get('label')).toEqual(["it's", 'plain']);
  });

  it('returns empty map when no CHECK IN clauses are present', () => {
    const got = extractCheckEnums(
      'CREATE TABLE t (id UUID PRIMARY KEY, name TEXT NOT NULL);',
    );
    expect(got.size).toBe(0);
  });
});

describe('parseDDL — CHECK constraint integration', () => {
  it('attaches checkAllowedValues to columns with CHECK IN clauses', () => {
    const schema = parseDDL(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        status TEXT CHECK (status IN ('active','inactive','trial'))
      );
    `);
    const status = schema.tables[0].columns.find((c) => c.name === 'status');
    expect(status?.checkAllowedValues).toEqual(['active', 'inactive', 'trial']);
    const email = schema.tables[0].columns.find((c) => c.name === 'email');
    expect(email?.checkAllowedValues).toBeUndefined();
  });
});

describe('sandbox — CHECK-constrained columns generate respecting values', () => {
  // PGlite WASM init plus DDL exec runs ~3-4s in isolation; under parallel
  // contention with sandbox.test.ts it can creep past the 5s default.
  it('does not violate the user-reported users_status_check constraint', { timeout: 20_000 }, async () => {
    resetSandboxState();
    const ddl = `
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        status TEXT CHECK (status IN ('active','inactive','trial'))
      );
    `;
    const schema = parseDDL(ddl);
    const result = await runSandbox({
      ddl,
      schema,
      sql: 'SELECT status, COUNT(*) AS n FROM users GROUP BY status',
      rowsPerTable: 30,
      seed: 7,
    });
    expect(result.executionError).toBeUndefined();
    // Every returned status row must be one of the allowed values.
    for (const row of result.rows) {
      expect(['active', 'inactive', 'trial']).toContain(row.status);
    }
  });
});
