import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { CustomRule } from '../types/validation';

const SCHEMA = parseDDL(`
  CREATE TABLE orders (id UUID PRIMARY KEY, tenant_id UUID, total_amount NUMERIC, status TEXT);
  CREATE TABLE users (id UUID PRIMARY KEY, email TEXT);
`);

const v = (sql: string, rules?: CustomRule[]) =>
  validateSQL({ sql, schema: SCHEMA, dialect: 'postgresql', customRules: rules });
const ids = (r: ReturnType<typeof v>) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

const requiredFilter: CustomRule = {
  id: 'r1', name: 'Tenant filter', rule_type: 'required_filter',
  config: { table: 'orders', column: 'tenant_id', message: 'Always filter orders by tenant_id' },
  severity: 'error', active: true,
};
const forbiddenTable: CustomRule = {
  id: 'r2', name: 'No raw PII', rule_type: 'forbidden_table',
  config: { table: 'raw_pii', message: 'Do not query raw_pii directly' }, severity: 'error', active: true,
};
const forbiddenPattern: CustomRule = {
  id: 'r3', name: 'No SELECT star', rule_type: 'forbidden_pattern',
  config: { pattern: 'SELECT\\s+\\*', message: 'SELECT * is forbidden in production' }, severity: 'warning', active: true,
};

describe('custom rules — required_filter', () => {
  it('fires when the table is queried but the column is not in WHERE', () => {
    const r = v("SELECT id FROM orders WHERE status = 'x'", [requiredFilter]);
    expect(ids(r)).toContain('CUSTOM_RULE');
    const issue = r.errors.find((e) => e.id === 'CUSTOM_RULE')!;
    expect(issue.description).toMatch(/Tenant filter/);
    expect(issue.metadata?.ruleId).toBe('r1');
  });
  it('does NOT fire when the filter is present', () => {
    const r = v("SELECT id FROM orders WHERE tenant_id = '1'", [requiredFilter]);
    expect(ids(r)).not.toContain('CUSTOM_RULE');
  });
});

describe('custom rules — forbidden_table', () => {
  it('fires on any FROM reference to the forbidden table', () => {
    const r = v('SELECT * FROM raw_pii', [forbiddenTable]);
    expect(ids(r)).toContain('CUSTOM_RULE');
  });
  it('does NOT fire when the table is absent', () => {
    expect(ids(v('SELECT id FROM users', [forbiddenTable]))).not.toContain('CUSTOM_RULE');
  });
});

describe('custom rules — forbidden_pattern + gating', () => {
  it('fires on a raw text match', () => {
    const r = v('SELECT * FROM users', [forbiddenPattern]);
    const issue = r.warnings.find((w) => w.id === 'CUSTOM_RULE')!;
    expect(issue).toBeDefined();
    expect(issue.description).toMatch(/No SELECT star/); // rule name in message
  });
  it('is not evaluated when no rules are supplied (non-Business gate)', () => {
    expect(ids(v('SELECT * FROM raw_pii'))).not.toContain('CUSTOM_RULE');
  });
});
