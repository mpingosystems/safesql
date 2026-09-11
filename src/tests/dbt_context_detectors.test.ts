import { describe, expect, it } from 'vitest';
import manifestJson from '../services/__fixtures__/dbt/manifest.json';
import catalogJson from '../services/__fixtures__/dbt/catalog.json';
import runResultsJson from '../services/__fixtures__/dbt/run_results.json';
import {
  parseDbtArtifacts,
  type DbtArtifactInput,
  type DbtCatalog,
  type DbtManifest,
  type DbtRunResults,
} from '../services/dbtArtifacts';
import { validateSQL } from '../services/sqlValidator';
import { PRO_DETECTOR_SLUGS, TOTAL_DETECTORS, isDetectorEnabled } from '../config/detectorTiers';
import type { ValidationReport } from '../types/validation';

// Sprint 8 Part 2 — UNAPPROVED_SOURCE and FINANCE_TAG_UNVALIDATED. Both are
// driven purely by request.dbtContext and must be silent without it.

const manifest = manifestJson as unknown as DbtManifest;
const catalog = catalogJson as unknown as DbtCatalog;
const runResults = runResultsJson as unknown as DbtRunResults;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function run(sql: string, input?: Partial<DbtArtifactInput> | null) {
  if (input === null) return validateSQL({ sql, dialect: 'postgresql' });
  const { schema, context } = parseDbtArtifacts({ manifest, catalog, runResults, ...input });
  return validateSQL({ sql, dialect: 'postgresql', schema, dbtContext: context });
}
const all = (r: ValidationReport) => [...r.errors, ...r.warnings, ...r.suggestions];
const ids = (r: ValidationReport) => all(r).map((i) => i.id);
const find = (r: ValidationReport, id: string) => all(r).filter((i) => i.id === id);

// The fixture lineage (see __fixtures__/dbt/README.md):
//   source raw.orders → stg_orders (view) → int_orders_enriched (ephemeral) → fct_revenue (finance, last run: error)

describe('UNAPPROVED_SOURCE', () => {
  it('7. fires on a raw source with a downstream mart, naming the nearest mart', () => {
    const r = run('SELECT id, amount FROM orders WHERE created_at > now() - interval \'7 days\'');
    const hits = find(r, 'UNAPPROVED_SOURCE');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      severity: 'warning',
      offendingClause: 'FROM',
      offendingTable: 'orders',
      description:
        "Query reads from raw source 'orders' directly. A trusted mart 'stg_orders' exists downstream. " +
        'Consider querying the mart instead.',
      metadata: { table: 'orders', sourceName: 'raw', nearestMart: 'stg_orders', marts: ['stg_orders', 'fct_revenue'] },
    });
    expect(hits[0].fix).toContain('"stg_orders"');
    expect(hits[0].fix).toContain('also available: fct_revenue');
    // high-risk warning band, with the contract's score impact
    expect(r.riskScore).toBeGreaterThanOrEqual(41);
    expect(r.riskScore).toBeLessThanOrEqual(69);
    expect(hits[0].scoreImpact).toBe(-40);
  });

  it('fires on a source reached through a JOIN, and once per source per statement', () => {
    const r = run('SELECT c.region, o.amount FROM dim_customers c JOIN orders o ON o.customer_id = c.customer_id JOIN orders o2 ON o2.id = o.id');
    const hits = find(r, 'UNAPPROVED_SOURCE');
    expect(hits).toHaveLength(1);
    expect(hits[0].offendingClause).toBe('JOIN');
  });

  it('8. does NOT fire when the model being validated is the staging model that reads this source', () => {
    // stg_orders is in sourceToMart['orders'] AND depends on 'orders' directly.
    const r = run('SELECT id AS order_id, customer_id, amount FROM orders', { currentModel: 'stg_orders' });
    expect(ids(r)).not.toContain('UNAPPROVED_SOURCE');
  });

  it('the exemption is structural: a downstream mart reaching past its staging layer is still flagged', () => {
    // fct_revenue is in sourceToMart['orders'] but depends on int_orders_enriched, not on 'orders'.
    const r = run('SELECT SUM(amount) FROM orders', { currentModel: 'fct_revenue' });
    expect(find(r, 'UNAPPROVED_SOURCE')).toHaveLength(1);
    // and a model that is not downstream of the source at all is flagged too
    const r2 = run('SELECT SUM(amount) FROM orders', { currentModel: 'dim_customers' });
    expect(find(r2, 'UNAPPROVED_SOURCE')).toHaveLength(1);
    // a currentModel the manifest does not know behaves like no currentModel
    const r3 = run('SELECT SUM(amount) FROM orders', { currentModel: 'scratch_query' });
    expect(find(r3, 'UNAPPROVED_SOURCE')).toHaveLength(1);
  });

  it('does NOT fire on a source with no downstream mart, or on a model', () => {
    const m = clone(manifest);
    // detach raw.customers from everything → no curated alternative exists
    m.nodes['model.shop.dim_customers'].depends_on = { nodes: [] };
    m.child_map!['source.shop.raw.customers'] = [];
    const { schema, context } = parseDbtArtifacts({ manifest: m, catalog });
    const r = validateSQL({ sql: 'SELECT email FROM customers', dialect: 'postgresql', schema, dbtContext: context });
    expect(ids(r)).not.toContain('UNAPPROVED_SOURCE');
    // models are never "raw sources"
    expect(ids(run('SELECT order_id FROM stg_orders'))).not.toContain('UNAPPROVED_SOURCE');
  });

  it('9. does NOT fire without dbtContext, even when the table name matches a source', () => {
    const r = run('SELECT id, amount FROM orders', null);
    expect(ids(r)).not.toContain('UNAPPROVED_SOURCE');
    expect(ids(r)).not.toContain('FINANCE_TAG_UNVALIDATED');
  });
});

describe('FINANCE_TAG_UNVALIDATED', () => {
  it('10. fires on a finance-tagged model whose last run errored', () => {
    const r = run('SELECT order_date, SUM(revenue) FROM fct_revenue GROUP BY order_date');
    const hits = find(r, 'FINANCE_TAG_UNVALIDATED');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      severity: 'warning',
      offendingClause: 'FROM',
      offendingTable: 'fct_revenue',
      description:
        "Query references 'fct_revenue' tagged 'finance'. Last validation status: error. " +
        'Review required before export or scheduling.',
      metadata: { table: 'fct_revenue', tag: 'finance', lastRunStatus: 'error', owner: 'finance-eng' },
    });
    expect(hits[0].fix).toContain('dbt run --select fct_revenue');
    expect(r.riskScore).toBeGreaterThanOrEqual(41);
    expect(r.riskScore).toBeLessThanOrEqual(69);
  });

  it('11. fires with status "unknown" on a finance-tagged model that has no run result at all', () => {
    const rr = clone(runResults);
    rr.results = rr.results.filter((x) => x.unique_id !== 'model.shop.fct_revenue');
    const { schema, context } = parseDbtArtifacts({ manifest, catalog, runResults: rr });
    const r = validateSQL({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dialect: 'postgresql', schema, dbtContext: context });
    const hits = find(r, 'FINANCE_TAG_UNVALIDATED');
    expect(hits).toHaveLength(1);
    expect(hits[0].description).toContain('Last validation status: unknown.');
    expect(hits[0].metadata).toMatchObject({ lastRunStatus: 'unknown' });
    // and likewise when no run_results.json was supplied at all
    const noRR = parseDbtArtifacts({ manifest, catalog });
    const r2 = validateSQL({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dialect: 'postgresql', schema: noRR.schema, dbtContext: noRR.context });
    expect(find(r2, 'FINANCE_TAG_UNVALIDATED')[0]?.metadata).toMatchObject({ lastRunStatus: 'unknown' });
  });

  it('12. does NOT fire on a finance-tagged model whose last run succeeded', () => {
    const rr = clone(runResults);
    rr.results.find((x) => x.unique_id === 'model.shop.fct_revenue')!.status = 'success';
    const { schema, context } = parseDbtArtifacts({ manifest, catalog, runResults: rr });
    const r = validateSQL({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dialect: 'postgresql', schema, dbtContext: context });
    expect(ids(r)).not.toContain('FINANCE_TAG_UNVALIDATED');
  });

  it('does NOT fire on an untagged model with a failed run, and respects custom sensitiveTags', () => {
    const rr = clone(runResults);
    rr.results.find((x) => x.unique_id === 'model.shop.stg_orders')!.status = 'error';
    const base = parseDbtArtifacts({ manifest, catalog, runResults: rr });
    const r = validateSQL({ sql: 'SELECT order_id FROM stg_orders', dialect: 'postgresql', schema: base.schema, dbtContext: base.context });
    expect(ids(r)).not.toContain('FINANCE_TAG_UNVALIDATED');
    // 'finance' is no longer sensitive when the caller configures other tags
    const r2 = run('SELECT SUM(revenue) FROM fct_revenue', { sensitiveTags: ['gdpr'] });
    expect(ids(r2)).not.toContain('FINANCE_TAG_UNVALIDATED');
    // every non-success status fires — the vocabulary is compared raw
    for (const status of ['fail', 'skipped', 'warn', 'something_new']) {
      const rr2 = clone(runResults);
      rr2.results.find((x) => x.unique_id === 'model.shop.fct_revenue')!.status = status;
      const p = parseDbtArtifacts({ manifest, catalog, runResults: rr2 });
      const rep = validateSQL({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dialect: 'postgresql', schema: p.schema, dbtContext: p.context });
      expect(find(rep, 'FINANCE_TAG_UNVALIDATED'), status).toHaveLength(1);
    }
  });

  it('13. does NOT fire without dbtContext', () => {
    const r = run('SELECT SUM(revenue) FROM fct_revenue', null);
    expect(ids(r)).not.toContain('FINANCE_TAG_UNVALIDATED');
  });
});

describe('Sprint 8 detector registration', () => {
  it('both detectors are Pro-tier and the headline count is 35', () => {
    expect(TOTAL_DETECTORS).toBe(35);
    expect(PRO_DETECTOR_SLUGS).toContain('UNAPPROVED_SOURCE');
    expect(PRO_DETECTOR_SLUGS).toContain('FINANCE_TAG_UNVALIDATED');
    expect(isDetectorEnabled('UNAPPROVED_SOURCE', 'pro')).toBe(true);
    expect(isDetectorEnabled('UNAPPROVED_SOURCE', 'free')).toBe(false);
    expect(isDetectorEnabled('FINANCE_TAG_UNVALIDATED', 'free')).toBe(false);
  });

  it('free tier withholds both and the upgrade prompt says 35', () => {
    const { schema, context } = parseDbtArtifacts({ manifest, catalog, runResults });
    const r = validateSQL({ sql: 'SELECT SUM(amount) FROM orders', dialect: 'postgresql', schema, dbtContext: context, tier: 'free' });
    expect(ids(r)).not.toContain('UNAPPROVED_SOURCE');
    expect(r.upgradePrompt).toContain('Upgrade to run all 35 detectors.');
    expect(r.detectorsRun).not.toContain('UNAPPROVED_SOURCE');
  });

  it('a clean query against the dbt schema still scores 100 with context present', () => {
    // stg_orders: success run, not tagged; reading it is exactly what the marts should do.
    const r = run('SELECT order_id, amount FROM stg_orders WHERE ordered_at >= now() - interval \'1 day\'');
    expect(all(r)).toEqual([]);
    expect(r.riskScore).toBe(100);
  });
});
