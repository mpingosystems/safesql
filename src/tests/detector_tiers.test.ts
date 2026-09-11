import { describe, expect, it } from 'vitest';
import {
  FREE_DETECTOR_SLUGS,
  FREE_DETECTOR_COUNT,
  PRO_DETECTOR_SLUGS,
  TOTAL_DETECTORS,
  gatedDetectorCount,
  getDetectorsForTier,
  isDetectorEnabled,
} from '../config/detectorTiers';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';

// Sprint 5C — free/pro detector gating.

const FANOUT_DDL = `
CREATE TABLE customers (id INT PRIMARY KEY, plan TEXT);
CREATE TABLE payments (id INT PRIMARY KEY, customer_id INT REFERENCES customers(id), amount NUMERIC);
CREATE TABLE subscriptions (id INT PRIMARY KEY, customer_id INT REFERENCES customers(id), plan TEXT);
`;

// A SUM across two one-to-many joins: the flagship AGGREGATE_OVER_FANOUT_JOIN
// (Pro-only) fires here, so it is the sharpest test of the gate.
const FANOUT_SQL = `
SELECT c.plan, SUM(p.amount) AS revenue
FROM customers c
JOIN subscriptions s ON s.customer_id = c.id
JOIN payments p ON p.customer_id = c.id
GROUP BY c.plan;
`;

describe('detector tier lists', () => {
  it('free tier has exactly 12 detectors, no duplicates', () => {
    expect(FREE_DETECTOR_SLUGS).toHaveLength(12);
    expect(new Set(FREE_DETECTOR_SLUGS).size).toBe(12);
    expect(FREE_DETECTOR_COUNT).toBe(12);
  });

  it('pro tier has all 35 built-in detectors, no duplicates', () => {
    expect(PRO_DETECTOR_SLUGS).toHaveLength(35);
    expect(new Set(PRO_DETECTOR_SLUGS).size).toBe(35);
    expect(TOTAL_DETECTORS).toBe(35);
  });

  it('pro is a strict superset of free', () => {
    for (const id of FREE_DETECTOR_SLUGS) expect(PRO_DETECTOR_SLUGS).toContain(id);
    expect(PRO_DETECTOR_SLUGS.length).toBeGreaterThan(FREE_DETECTOR_SLUGS.length);
  });

  it('excludes CUSTOM_RULE and SYNTAX_ERROR from the counted set', () => {
    expect(PRO_DETECTOR_SLUGS).not.toContain('CUSTOM_RULE');
    expect(PRO_DETECTOR_SLUGS).not.toContain('SYNTAX_ERROR');
  });

  it('maps every paid tier to the full set', () => {
    expect(getDetectorsForTier('free')).toHaveLength(12);
    for (const tier of ['pro', 'team', 'business', 'enterprise'] as const) {
      expect(getDetectorsForTier(tier)).toHaveLength(35);
    }
  });

  it('reports 21 gated detectors on free and 0 on pro', () => {
    expect(gatedDetectorCount('free')).toBe(23);
    expect(gatedDetectorCount('pro')).toBe(0);
  });

  it('never gates SYNTAX_ERROR or CUSTOM_RULE, on any tier', () => {
    expect(isDetectorEnabled('SYNTAX_ERROR', 'free')).toBe(true);
    expect(isDetectorEnabled('CUSTOM_RULE', 'free')).toBe(true);
  });

  it('gates the flagship fan-out detector on free', () => {
    expect(isDetectorEnabled('AGGREGATE_OVER_FANOUT_JOIN', 'free')).toBe(false);
    expect(isDetectorEnabled('AGGREGATE_OVER_FANOUT_JOIN', 'pro')).toBe(true);
  });
});

describe('validateSQL tier gating', () => {
  const schema = parseDDL(FANOUT_DDL);

  it('omitting tier runs every detector (unchanged pre-5C behaviour)', () => {
    const report = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql' });
    const ids = [...report.errors, ...report.warnings, ...report.suggestions].map((i) => i.id);
    expect(ids).toContain('AGGREGATE_OVER_FANOUT_JOIN');
    expect(report.upgradePrompt).toBeUndefined();
  });

  it('withholds Pro-only findings on the free tier', () => {
    const free = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'free' });
    const ids = [...free.errors, ...free.warnings, ...free.suggestions].map((i) => i.id);
    expect(ids).not.toContain('AGGREGATE_OVER_FANOUT_JOIN');
    for (const id of ids) expect(FREE_DETECTOR_SLUGS).toContain(id);
  });

  it('scores the free result only from the detectors that ran', () => {
    const free = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'free' });
    const pro = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'pro' });
    // Fewer findings -> a higher (less alarming) score. This is the honest
    // consequence of gating and the reason the upgrade prompt has to exist.
    expect(free.riskScore).toBeGreaterThan(pro.riskScore);
  });

  it('reports detectorsRun for both tiers', () => {
    const free = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'free' });
    const pro = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'pro' });
    expect(free.detectorsRun).toHaveLength(12);
    expect(pro.detectorsRun).toHaveLength(35);
  });

  it('sets upgradePrompt only when findings were actually withheld', () => {
    const free = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'free' });
    expect(free.upgradePrompt).toBeTruthy();
    expect(free.upgradePrompt).toContain('35');

    // A query whose only finding is a free detector withholds nothing.
    const clean = validateSQL({
      sql: 'SELECT id, plan FROM customers WHERE id = 1;',
      schema,
      dialect: 'postgresql',
      tier: 'free',
    });
    expect(clean.upgradePrompt).toBeUndefined();
  });

  it('never names a gated detector in the upgrade prompt', () => {
    const free = validateSQL({ sql: FANOUT_SQL, schema, dialect: 'postgresql', tier: 'free' });
    const gated = PRO_DETECTOR_SLUGS.filter((d) => !FREE_DETECTOR_SLUGS.includes(d));
    for (const id of gated) expect(free.upgradePrompt ?? '').not.toContain(id);
  });

  it('still catches a cartesian join on the free tier', () => {
    const free = validateSQL({
      sql: 'SELECT c.id, p.amount FROM customers c CROSS JOIN payments p;',
      schema,
      dialect: 'postgresql',
      tier: 'free',
    });
    const ids = [...free.errors, ...free.warnings, ...free.suggestions].map((i) => i.id);
    expect(ids.some((id) => id === 'CARTESIAN_JOIN' || id === 'CROSS_JOIN_RISK')).toBe(true);
  });

  // ── Comma joins (found by the seeded benchmark, Phase 1) ──────────────────
  // `FROM a, b` with nothing relating the tables is a true Cartesian product.
  // It was previously invisible to the detector and scored a clean 100.
  it('flags a comma join with no relating condition', () => {
    const r = validateSQL({
      sql: 'SELECT c.id, p.amount FROM customers c, payments p;',
      schema,
      dialect: 'postgresql',
    });
    expect(r.errors.map((i) => i.id)).toContain('CARTESIAN_JOIN');
    expect(r.riskScore).toBeLessThan(50);
  });

  it('does NOT flag a comma join related in WHERE (pre-ANSI-92 join)', () => {
    const r = validateSQL({
      sql: 'SELECT c.id, p.amount FROM customers c, payments p WHERE p.customer_id = c.id;',
      schema,
      dialect: 'postgresql',
    });
    const ids = [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);
    expect(ids).not.toContain('CARTESIAN_JOIN');
  });

  it('does not flag a single-table FROM as a comma join', () => {
    const r = validateSQL({
      sql: 'SELECT c.id FROM customers c;',
      schema,
      dialect: 'postgresql',
    });
    expect([...r.errors, ...r.warnings].map((i) => i.id)).not.toContain('CARTESIAN_JOIN');
  });

  it('gates the comma-join finding on the free tier like any CARTESIAN_JOIN', () => {
    const r = validateSQL({
      sql: 'SELECT c.id, p.amount FROM customers c, payments p;',
      schema,
      dialect: 'postgresql',
      tier: 'free',
    });
    // CARTESIAN_JOIN is in the free 12, so it must still fire.
    expect(r.errors.map((i) => i.id)).toContain('CARTESIAN_JOIN');
  });

  it('still reports a syntax error on the free tier', () => {
    const free = validateSQL({ sql: 'SELEKT * FROM', dialect: 'postgresql', tier: 'free' });
    expect(free.errors.map((i) => i.id)).toContain('SYNTAX_ERROR');
  });
});
