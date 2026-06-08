import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import type { SchemaDefinition, ValidationReport } from '../types/validation';

// Schema mirroring the Sprint 3 prompt examples.
const SCHEMA: SchemaDefinition = parseDDL(`
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    country TEXT,
    status TEXT,
    plan_id UUID,
    created_at TIMESTAMPTZ
  );
  CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    total_amount NUMERIC(10,2),
    status TEXT,
    order_date DATE,
    created_at TIMESTAMPTZ
  );
  CREATE TABLE products (
    id UUID PRIMARY KEY,
    product_name TEXT NOT NULL
  );
`);

type SchemaArg = SchemaDefinition | undefined | null;
const v = (sql: string, schema: SchemaArg = SCHEMA): ValidationReport => {
  const effective = schema === null ? undefined : schema;
  return validateSQL({ sql, schema: effective, dialect: 'postgresql' });
};

const allIds = (r: ValidationReport) =>
  [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);
const find = (r: ValidationReport, id: string) =>
  [...r.errors, ...r.warnings, ...r.suggestions].find((i) => i.id === id);

// ── Section 1: Schema Reference Validator ────────────────────────────────────
describe('S3: UNKNOWN_ALIAS', () => {
  it('flags an undefined alias qualifier', () => {
    const r = v('SELECT x.email FROM users u');
    expect(allIds(r)).toContain('UNKNOWN_ALIAS');
    const issue = find(r, 'UNKNOWN_ALIAS')!;
    expect(issue.metadata?.alias).toBe('x');
    expect(issue.fix).toMatch(/u/);
    expect(r.riskScore).toBeLessThan(50);
  });

  it('does not flag a defined alias', () => {
    const r = v('SELECT u.email FROM users u');
    expect(allIds(r)).not.toContain('UNKNOWN_ALIAS');
  });

  it('does not flag a bare table name used as qualifier', () => {
    const r = v('SELECT users.email FROM users');
    expect(allIds(r)).not.toContain('UNKNOWN_ALIAS');
  });
});

describe('S4: AMBIGUOUS_COLUMN', () => {
  it('flags an unqualified column that exists on multiple joined tables', () => {
    const r = v('SELECT id, status FROM users u JOIN orders o ON o.user_id = u.id');
    expect(allIds(r)).toContain('AMBIGUOUS_COLUMN');
    const issue = find(r, 'AMBIGUOUS_COLUMN')!;
    expect(issue.severity).toBe('warning');
    expect(issue.offendingColumn).toBeTruthy();
    expect(r.riskScore).toBeLessThan(70);
  });

  it('does not flag when the column is qualified', () => {
    const r = v('SELECT u.id, o.status FROM users u JOIN orders o ON o.user_id = u.id');
    expect(allIds(r)).not.toContain('AMBIGUOUS_COLUMN');
  });
});

// ── Section 2: JOIN Semantics ────────────────────────────────────────────────
describe('J1: LEFT_JOIN_FILTERED_IN_WHERE', () => {
  it('flags a WHERE filter on the nullable side of a LEFT JOIN', () => {
    const r = v(`
      SELECT u.id, u.email, COUNT(o.id) AS completed_orders
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id
      WHERE o.status = 'completed'
      GROUP BY u.id, u.email`);
    expect(allIds(r)).toContain('LEFT_JOIN_FILTERED_IN_WHERE');
    const issue = find(r, 'LEFT_JOIN_FILTERED_IN_WHERE')!;
    expect(issue.offendingClause).toBe('WHERE');
    expect(issue.offendingTable).toBe('orders');
    expect(issue.offendingColumn).toBe('status');
    expect(issue.fix).toMatch(/ON/);
    expect(r.riskScore).toBeLessThan(70);
  });

  it('J2: does NOT flag the correct ON-clause placement', () => {
    const r = v(`
      SELECT u.id, u.email, COUNT(o.id) AS completed_orders
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'completed'
      GROUP BY u.id, u.email`);
    expect(allIds(r)).not.toContain('LEFT_JOIN_FILTERED_IN_WHERE');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });
});

describe('J3: SUSPICIOUS_JOIN_KEY', () => {
  it('flags id = id across tables', () => {
    const r = v('SELECT u.email, o.total_amount FROM users u JOIN orders o ON u.id = o.id');
    expect(allIds(r)).toContain('SUSPICIOUS_JOIN_KEY');
    expect(r.riskScore).toBeLessThan(70);
  });

  it('does not flag a normal FK join', () => {
    const r = v('SELECT u.email FROM users u JOIN orders o ON o.user_id = u.id');
    expect(allIds(r)).not.toContain('SUSPICIOUS_JOIN_KEY');
  });
});

describe('J4 / J5: Cartesian & Cross join', () => {
  it('flags a JOIN with no ON clause as CARTESIAN_JOIN', () => {
    const r = v('SELECT u.email, p.product_name FROM users u JOIN products p');
    expect(allIds(r)).toContain('CARTESIAN_JOIN');
    expect(find(r, 'CARTESIAN_JOIN')!.severity).toBe('error');
    expect(r.riskScore).toBeLessThan(50);
  });

  it('flags an explicit CROSS JOIN as CROSS_JOIN_RISK', () => {
    const r = v('SELECT u.email, p.product_name FROM users u CROSS JOIN products p');
    expect(allIds(r)).toContain('CROSS_JOIN_RISK');
    expect(r.riskScore).toBeLessThan(70);
  });
});

// ── Section 3: Fan-Out & Grain ───────────────────────────────────────────────
describe('F1: AGGREGATE_OVER_FANOUT_JOIN', () => {
  it('flags SUM inflated by a second join to the same parent', () => {
    const r = v(
      `SELECT u.country, SUM(o.total_amount) AS revenue
       FROM users u
       JOIN orders o ON o.user_id = u.id
       JOIN user_tags t ON t.user_id = u.id
       GROUP BY u.country`,
      null,
    );
    expect(allIds(r)).toContain('AGGREGATE_OVER_FANOUT_JOIN');
    const issue = find(r, 'AGGREGATE_OVER_FANOUT_JOIN')!;
    expect(issue.offendingTable).toBe('user_tags');
    expect(issue.offendingColumn).toBe('total_amount');
    expect(r.riskScore).toBeLessThan(70);
  });
});

describe('F2 / F3: Multiple 1:M joins vs safe rewrite', () => {
  it('F2: flags two child tables joined to the same parent', () => {
    const r = v(
      `SELECT u.country, COUNT(o.id) AS order_count, COUNT(st.id) AS ticket_count
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       LEFT JOIN support_tickets st ON st.user_id = u.id
       GROUP BY u.country`,
      null,
    );
    expect(allIds(r)).toContain('MULTIPLE_ONE_TO_MANY_JOINS');
    expect(r.riskScore).toBeLessThan(70);
  });

  it('F3: does NOT flag the pre-aggregated CTE rewrite', () => {
    const r = v(
      `WITH order_counts AS (SELECT user_id, COUNT(*) AS order_count FROM orders GROUP BY user_id),
       ticket_counts AS (SELECT user_id, COUNT(*) AS ticket_count FROM support_tickets GROUP BY user_id)
       SELECT u.country, COALESCE(oc.order_count, 0), COALESCE(tc.ticket_count, 0)
       FROM users u
       LEFT JOIN order_counts oc ON oc.user_id = u.id
       LEFT JOIN ticket_counts tc ON tc.user_id = u.id
       GROUP BY u.country`,
      null,
    );
    expect(allIds(r)).not.toContain('MULTIPLE_ONE_TO_MANY_JOINS');
    expect(allIds(r)).not.toContain('AGGREGATE_OVER_FANOUT_JOIN');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });
});

describe('F4 / F5: SCD join effective date', () => {
  it('F4: flags a history table joined without a date range', () => {
    const r = v(
      `SELECT ph.plan_name, SUM(o.total_amount) AS revenue
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN plan_history ph ON ph.plan_id = u.plan_id
       GROUP BY ph.plan_name`,
      null,
    );
    expect(allIds(r)).toContain('SCD_JOIN_WITHOUT_EFFECTIVE_DATE');
    expect(find(r, 'SCD_JOIN_WITHOUT_EFFECTIVE_DATE')!.offendingTable).toBe('plan_history');
    expect(r.riskScore).toBeLessThan(70);
  });

  it('F5: does NOT flag a history join with an effective-date range', () => {
    const r = v(
      `SELECT ph.plan_name, SUM(o.total_amount) AS revenue
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN plan_history ph ON ph.plan_id = u.plan_id
         AND o.order_date >= ph.valid_from
         AND (ph.valid_to IS NULL OR o.order_date < ph.valid_to)
       GROUP BY ph.plan_name`,
      null,
    );
    expect(allIds(r)).not.toContain('SCD_JOIN_WITHOUT_EFFECTIVE_DATE');
  });
});

// ── Section 5: Aggregation & Metric ──────────────────────────────────────────
describe('A1: INTEGER_DIVISION_RISK', () => {
  it('flags COUNT / COUNT integer division', () => {
    const r = v(
      "SELECT COUNT(CASE WHEN status = 'churned' THEN 1 END) / COUNT(*) AS churn_rate FROM users",
    );
    expect(allIds(r)).toContain('INTEGER_DIVISION_RISK');
    expect(find(r, 'INTEGER_DIVISION_RISK')!.fix).toMatch(/decimal|FLOAT|cast/i);
  });

  it('does not flag a cast numerator', () => {
    const r = v('SELECT COUNT(*)::decimal / COUNT(*) AS ratio FROM users');
    expect(allIds(r)).not.toContain('INTEGER_DIVISION_RISK');
  });
});

describe('A3: COUNT_PARENT_AFTER_CHILD_JOIN', () => {
  it('flags COUNT(*) after joining a child table', () => {
    const r = v(
      `SELECT u.country, COUNT(*) AS user_count
       FROM users u
       JOIN orders o ON o.user_id = u.id
       GROUP BY u.country`,
    );
    expect(allIds(r)).toContain('COUNT_PARENT_AFTER_CHILD_JOIN');
    expect(find(r, 'COUNT_PARENT_AFTER_CHILD_JOIN')!.fix).toMatch(/DISTINCT/);
  });

  it('does not flag COUNT(*) without a join', () => {
    const r = v('SELECT COUNT(*) FROM users');
    expect(allIds(r)).not.toContain('COUNT_PARENT_AFTER_CHILD_JOIN');
  });
});

// ── Section 6: Time Filter ───────────────────────────────────────────────────
describe('T1: MISSING_TIME_FILTER', () => {
  it('flags a revenue SUM with a non-date filter and no time window', () => {
    const r = v("SELECT SUM(total_amount) AS revenue FROM orders WHERE status = 'completed'");
    expect(allIds(r)).toContain('MISSING_TIME_FILTER');
    expect(r.riskScore).toBeLessThan(85);
  });

  it('does not flag a plain grouped rollup with no WHERE', () => {
    const r = v('SELECT user_id, SUM(total_amount) FROM orders GROUP BY user_id');
    expect(allIds(r)).not.toContain('MISSING_TIME_FILTER');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });

  it('does not flag when a date predicate is present', () => {
    const r = v(
      "SELECT SUM(total_amount) FROM orders WHERE status = 'completed' AND order_date >= '2026-01-01'",
    );
    expect(allIds(r)).not.toContain('MISSING_TIME_FILTER');
  });
});

// ── Section 7: Dialect ───────────────────────────────────────────────────────
describe('Dialect: DIALECT_MISMATCH', () => {
  it('flags a BigQuery function in PostgreSQL mode', () => {
    const r = validateSQL({
      sql: 'SELECT * FROM orders WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)',
      schema: SCHEMA,
      dialect: 'postgresql',
    });
    expect(allIds(r)).toContain('DIALECT_MISMATCH');
    expect(find(r, 'DIALECT_MISMATCH')!.metadata?.function).toBe('DATE_SUB');
  });

  it('does not flag the same function in BigQuery mode', () => {
    const r = validateSQL({
      sql: 'SELECT * FROM orders WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)',
      schema: SCHEMA,
      dialect: 'bigquery',
    });
    expect(allIds(r)).not.toContain('DIALECT_MISMATCH');
  });
});

// ── Section 8: Window Functions ──────────────────────────────────────────────
describe('WN1: NON_DETERMINISTIC_WINDOW_ORDER', () => {
  it('flags ROW_NUMBER ordered by a single column', () => {
    const r = v(
      `SELECT user_id, order_date,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY order_date DESC) AS rn
       FROM orders`,
    );
    expect(allIds(r)).toContain('NON_DETERMINISTIC_WINDOW_ORDER');
    expect(find(r, 'NON_DETERMINISTIC_WINDOW_ORDER')!.severity).toBe('suggestion');
    expect(r.riskScore).toBeGreaterThanOrEqual(85);
  });

  it('does not flag when a tie-breaker column is present', () => {
    const r = v(
      `SELECT user_id,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY order_date DESC, id DESC) AS rn
       FROM orders`,
    );
    expect(allIds(r)).not.toContain('NON_DETERMINISTIC_WINDOW_ORDER');
  });
});

// ── Section 9: Destructive SQL ───────────────────────────────────────────────
describe('X3 / X4: Destructive DDL', () => {
  it('flags DROP TABLE', () => {
    const r = v('DROP TABLE users');
    expect(allIds(r)).toContain('DESTRUCTIVE_DDL');
    expect(r.riskScore).toBeLessThan(50);
    expect(r.executionSafe).toBe(false);
  });

  it('flags TRUNCATE TABLE', () => {
    const r = v('TRUNCATE TABLE orders');
    expect(allIds(r)).toContain('DESTRUCTIVE_TRUNCATE');
    expect(r.riskScore).toBeLessThan(50);
  });
});

// ── Section 10: Issue Object Contract ────────────────────────────────────────
describe('Issue Object Contract (§10)', () => {
  it('every issue carries issueType (id), severity, message, fix and scoreImpact', () => {
    const samples = [
      'SELECT id, lifetime_value FROM users',
      "SELECT SUM(o.total_amount) FROM users u JOIN orders o ON o.user_id=u.id JOIN user_tags t ON t.user_id=u.id GROUP BY u.country",
      'SELECT u.email, p.product_name FROM users u JOIN products p',
      'DROP TABLE users',
    ];
    for (const sql of samples) {
      const r = v(sql);
      const issues = [...r.errors, ...r.warnings, ...r.suggestions];
      expect(issues.length).toBeGreaterThan(0);
      for (const i of issues) {
        expect(i.id).toBeTruthy();
        expect(['error', 'warning', 'suggestion']).toContain(i.severity);
        expect(i.description).toBeTruthy();
        expect(i.fix && i.fix.length).toBeGreaterThan(0);
        expect(typeof i.scoreImpact).toBe('number');
        expect(i.scoreImpact!).toBeLessThan(0);
        // at least one anchor where applicable
        const anchored = i.offendingClause || i.offendingTable || i.offendingColumn;
        expect(anchored).toBeTruthy();
      }
    }
  });
});

// ── Section 11: Score Policy ─────────────────────────────────────────────────
describe('Score Policy (§11)', () => {
  it('fixed query always scores higher than the flawed original', () => {
    const bad = v(
      `SELECT u.country, SUM(o.total_amount) AS revenue
       FROM users u
       JOIN orders o ON o.user_id = u.id
       JOIN user_tags t ON t.user_id = u.id
       GROUP BY u.country`,
      null,
    );
    const fixed = v(
      `WITH order_totals AS (SELECT user_id, SUM(total_amount) AS revenue FROM orders GROUP BY user_id)
       SELECT u.country, SUM(ot.revenue) AS revenue
       FROM users u
       JOIN order_totals ot ON ot.user_id = u.id
       JOIN user_tags t ON t.user_id = u.id
       GROUP BY u.country`,
      null,
    );
    expect(fixed.riskScore).toBeGreaterThan(bad.riskScore);
  });

  it('clean queries score at least 85', () => {
    expect(v('SELECT id, email FROM users WHERE id = 1').riskScore).toBeGreaterThanOrEqual(85);
  });
});

// ── Section 13: Minimum Re-Test Set ──────────────────────────────────────────
describe('Section 13: minimum re-test set', () => {
  const cases: Array<[string, string, string]> = [
    ['UNKNOWN/HALLUCINATED_COLUMN', 'SELECT id, lifetime_value FROM users', 'HALLUCINATED_COLUMN'],
    [
      'LEFT_JOIN_FILTERED_IN_WHERE',
      "SELECT u.id, u.email, COUNT(o.id) AS completed_orders FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE o.status = 'completed' GROUP BY u.id, u.email",
      'LEFT_JOIN_FILTERED_IN_WHERE',
    ],
    [
      'AGGREGATE_OVER_FANOUT_JOIN',
      'SELECT u.country, SUM(o.total_amount) AS revenue FROM users u JOIN orders o ON o.user_id = u.id JOIN user_tags t ON t.user_id = u.id GROUP BY u.country',
      'AGGREGATE_OVER_FANOUT_JOIN',
    ],
    [
      'SUSPICIOUS_JOIN_KEY',
      'SELECT u.email, o.total_amount FROM users u JOIN orders o ON u.id = o.id',
      'SUSPICIOUS_JOIN_KEY',
    ],
    [
      'CARTESIAN_JOIN',
      'SELECT u.email, p.product_name FROM users u JOIN products p',
      'CARTESIAN_JOIN',
    ],
  ];

  for (const [label, sql, expectedId] of cases) {
    it(`${label}: scores < 70 with a structured, fixable issue`, () => {
      const r = v(sql);
      expect(r.riskScore).toBeLessThan(70);
      expect(r.riskScore).not.toBe(100);
      expect(allIds(r)).toContain(expectedId);
      const issue = find(r, expectedId)!;
      expect(issue.description).toBeTruthy();
      expect(issue.fix && issue.fix.trim().length).toBeGreaterThan(0);
    });
  }
});
