import { describe, expect, it } from 'vitest';
import manifestJson from '../services/__fixtures__/dbt/manifest.json';
import catalogJson from '../services/__fixtures__/dbt/catalog.json';
import runResultsJson from '../services/__fixtures__/dbt/run_results.json';
import {
  DEFAULT_SENSITIVE_TAGS,
  looksLikeDbtManifest,
  mergeSchemas,
  parseDbtArtifacts,
  type DbtCatalog,
  type DbtManifest,
  type DbtRunResults,
} from '../services/dbtArtifacts';
import { parseDDL } from '../services/schemaParser';
import type { SchemaColumn, SchemaDefinition } from '../types/validation';

// Sprint 8 Part 1 — dbt artifact parser. Pure function over the committed
// fixture (src/services/__fixtures__/dbt — see its README for the shape).

// The fixture JSON is wider than the parser's structural input types (dbt
// writes many keys we never read); the casts assert only the keys we depend on.
const manifest = manifestJson as unknown as DbtManifest;
const catalog = catalogJson as unknown as DbtCatalog;
const runResults = runResultsJson as unknown as DbtRunResults;

// Deep-clone so a test can mutate its own copy without touching the others.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const table = (schema: SchemaDefinition, name: string) => {
  const t = schema.tables.find((x) => x.name === name);
  if (!t) throw new Error(`fixture table ${name} missing`);
  return t;
};
const column = (schema: SchemaDefinition, tbl: string, col: string): SchemaColumn => {
  const c = table(schema, tbl).columns.find((x) => x.name === col);
  if (!c) throw new Error(`fixture column ${tbl}.${col} missing`);
  return c;
};
const names = (schema: SchemaDefinition, tbl: string) => table(schema, tbl).columns.map((c) => c.name);

describe('parseDbtArtifacts — schema enrichment', () => {
  const { schema, warnings } = parseDbtArtifacts({ manifest, catalog, runResults });

  it('1. derives isPK from unique + not_null tests on the same column', () => {
    expect(column(schema, 'stg_orders', 'order_id').isPK).toBe(true);
    expect(column(schema, 'dim_customers', 'customer_id').isPK).toBe(true);
    // unique alone is not a PK, and neither is not_null alone
    expect(column(schema, 'fct_revenue', 'revenue').isPK).toBe(false);
    expect(column(schema, 'stg_orders', 'amount').isPK).toBe(false);
  });

  it('2. derives isFK + fkReferencesTable/Column from a relationships test', () => {
    const c = column(schema, 'stg_orders', 'customer_id');
    expect(c.isFK).toBe(true);
    expect(c.fkReferencesTable).toBe('dim_customers');
    expect(c.fkReferencesColumn).toBe('customer_id');
    // and the target side is not spuriously marked as an FK
    expect(column(schema, 'dim_customers', 'customer_id').isFK).toBe(false);
  });

  it('3. nullable is true exactly when there is no not_null test (PKs are NOT NULL)', () => {
    expect(column(schema, 'stg_orders', 'customer_id').nullable).toBe(true); // FK with no not_null
    expect(column(schema, 'stg_orders', 'amount').nullable).toBe(true);
    expect(column(schema, 'stg_orders', 'order_id').nullable).toBe(false); // PK
    expect(column(schema, 'fct_revenue', 'revenue').nullable).toBe(false); // not_null only
  });

  it('4. catalog types win over manifest data_type, and catalog-only columns are included', () => {
    // manifest documents revenue as "number"; the warehouse says numeric(12,2)
    expect(column(schema, 'fct_revenue', 'revenue').type).toBe('numeric(12,2)');
    // order_status exists in the catalog only — the whole point of reading it
    expect(column(schema, 'stg_orders', 'order_status').type).toBe('character varying(16)');
    expect(names(schema, 'stg_orders')).toEqual([
      'order_id', 'customer_id', 'amount', 'ordered_at', 'order_status',
    ]);
    // manifest data_type fills the gap when there is no catalog node
    expect(column(schema, 'int_orders_enriched', 'amount').type).toBe('numeric');
    // catalog row_count → estimatedRows
    expect(table(schema, 'fct_revenue')).toMatchObject({ estimatedRows: 1284403 });
    expect(table(schema, 'stg_orders')).not.toHaveProperty('estimatedRows');
    expect(warnings).toEqual([]);
  });

  it('includes models, sources, seeds and snapshots as tables — never tests', () => {
    const names = schema.tables.map((t) => t.name).sort();
    expect(names).toEqual(['customers', 'dim_customers', 'fct_revenue', 'int_orders_enriched', 'orders', 'stg_orders']);
  });

  it('without a catalog, falls back to manifest columns and types', () => {
    const { schema: s, context } = parseDbtArtifacts({ manifest });
    expect(column(s, 'fct_revenue', 'revenue').type).toBe('number');
    expect(names(s, 'stg_orders')).not.toContain('order_status');
    expect(column(s, 'stg_orders', 'order_id').isPK).toBe(true); // tests still apply
    expect(context.artifacts).toEqual({ catalog: false, runResults: false });
  });
});

describe('parseDbtArtifacts — lineage and context', () => {
  const { context } = parseDbtArtifacts({ manifest, catalog, runResults });

  it('5. sourceToMart lists every trusted mart transitively downstream of a source, nearest first', () => {
    // raw.orders → stg_orders (1) → int_orders_enriched (2, ephemeral) → fct_revenue (3)
    expect(context.sourceToMart.get('orders')).toEqual(['stg_orders', 'fct_revenue']);
    // raw.customers → dim_customers (1) → int (2) → fct_revenue (3)
    expect(context.sourceToMart.get('customers')).toEqual(['dim_customers', 'fct_revenue']);
    expect(context.models.get('stg_orders')?.isTrustedMart).toBe(true);
    expect(context.models.get('fct_revenue')?.isTrustedMart).toBe(true);
  });

  it('6. ephemeral models are traversed for lineage but never listed as marts', () => {
    const eph = context.models.get('int_orders_enriched');
    expect(eph?.materialized).toBe('ephemeral');
    expect(eph?.isTrustedMart).toBe(false);
    for (const marts of context.sourceToMart.values()) expect(marts).not.toContain('int_orders_enriched');
    // a model with no path back to a source is not a trusted mart either
    const m = clone(manifest);
    m.nodes['model.shop.orphan'] = {
      ...clone(m.nodes['model.shop.dim_customers']),
      unique_id: 'model.shop.orphan', name: 'orphan', alias: 'orphan',
      depends_on: { nodes: [] },
    };
    expect(parseDbtArtifacts({ manifest: m }).context.models.get('orphan')?.isTrustedMart).toBe(false);
  });

  it('derives lineage from depends_on when the manifest carries no child_map', () => {
    const m = clone(manifest);
    delete m.child_map;
    delete m.parent_map;
    const { context: c } = parseDbtArtifacts({ manifest: m });
    expect(c.sourceToMart.get('orders')).toEqual(['stg_orders', 'fct_revenue']);
  });

  it('records tags, materialization, owner, dependsOn and run status per relation', () => {
    const fct = context.models.get('fct_revenue');
    expect(fct).toMatchObject({
      uniqueId: 'model.shop.fct_revenue',
      resourceType: 'model',
      tags: ['finance'],
      materialized: 'table',
      lastRunStatus: 'error',
      owner: 'finance-eng',
      dependsOn: ['int_orders_enriched'],
    });
    expect(context.models.get('stg_orders')).toMatchObject({ lastRunStatus: 'success', dependsOn: ['orders'] });
    // ephemeral models are never run — no status, not a default
    expect(context.models.get('int_orders_enriched')?.lastRunStatus).toBeUndefined();
    const src = context.sources.get('orders');
    expect(src).toMatchObject({ resourceType: 'source', sourceName: 'raw', relation: 'orders', isTrustedMart: false });
    expect(context.models.has('orders')).toBe(false); // sources live in their own map
    expect(context.dbtVersion).toBe('1.8.4');
    expect(context.artifacts).toEqual({ catalog: true, runResults: true });
  });

  it("normalises run_results 'skipped' to 'skip' and treats unknown statuses as not-success", () => {
    const rr = clone(runResults);
    rr.results[0].status = 'skipped';
    rr.results[1].status = 'something_new';
    const { context: c } = parseDbtArtifacts({ manifest, runResults: rr });
    expect(c.models.get('stg_orders')?.lastRunStatus).toBe('skip');
    expect(c.models.get('dim_customers')?.lastRunStatus).toBe('error');
  });

  it('sensitiveTags default to finance + pii, are lower-cased when supplied, and currentModel passes through', () => {
    expect(context.sensitiveTags).toEqual([...DEFAULT_SENSITIVE_TAGS]);
    expect(context.currentModel).toBeUndefined();
    const { context: c } = parseDbtArtifacts({ manifest, sensitiveTags: ['Finance', 'GDPR'], currentModel: 'stg_orders' });
    expect(c.sensitiveTags).toEqual(['finance', 'gdpr']);
    expect(c.currentModel).toBe('stg_orders');
  });

  it('registers alias / identifier as a second key when it differs from the logical name', () => {
    const m = clone(manifest);
    m.nodes['model.shop.fct_revenue'].alias = 'revenue_facts';
    m.sources!['source.shop.raw.orders'].identifier = 'raw_orders_v2';
    const { schema: s, context: c } = parseDbtArtifacts({ manifest: m, catalog });
    expect(c.models.get('fct_revenue')?.physicalName).toBe('revenue_facts');
    expect(c.models.get('revenue_facts')).toBe(c.models.get('fct_revenue'));
    expect(c.sources.get('raw_orders_v2')).toBe(c.sources.get('orders'));
    expect(c.sourceToMart.get('raw_orders_v2')).toEqual(c.sourceToMart.get('orders'));
    // both names resolve as schema tables, with identical columns
    expect(table(s, 'revenue_facts').columns).toEqual(table(s, 'fct_revenue').columns);
    expect(table(s, 'raw_orders_v2').columns).toEqual(table(s, 'orders').columns);
  });
});

describe('dbtArtifacts helpers', () => {
  it('looksLikeDbtManifest accepts a nodes map and rejects everything else', () => {
    expect(looksLikeDbtManifest(manifest)).toBe(true);
    expect(looksLikeDbtManifest({ nodes: [] })).toBe(false);
    expect(looksLikeDbtManifest({ results: [] })).toBe(false);
    expect(looksLikeDbtManifest(null)).toBe(false);
    expect(looksLikeDbtManifest('{}')).toBe(false);
    expect(() => parseDbtArtifacts({ manifest: { results: [] } as unknown as DbtManifest })).toThrow(/manifest/);
  });

  it('mergeSchemas lets an explicit DDL win per table and appends artifact-only tables', () => {
    const { schema: fromDbt } = parseDbtArtifacts({ manifest, catalog });
    const user = parseDDL('CREATE TABLE fct_revenue (order_id INT PRIMARY KEY, revenue INT);');
    const merged = mergeSchemas(user, fromDbt);
    // user's fct_revenue definition survives untouched
    expect(names(merged, 'fct_revenue')).toEqual(['order_id', 'revenue']);
    // everything the user did not define comes from the artifacts
    expect(merged.tables.map((t) => t.name)).toContain('stg_orders');
    expect(merged.tables.filter((t) => t.name.toLowerCase() === 'fct_revenue')).toHaveLength(1);
    // no user DDL → artifacts as-is
    expect(mergeSchemas(undefined, fromDbt)).toBe(fromDbt);
    expect(mergeSchemas({ tables: [] }, fromDbt)).toBe(fromDbt);
  });

  it('warns, rather than throws, on a catalog node with no manifest twin and an odd schema version', () => {
    const cat = clone(catalog);
    cat.nodes['model.shop.retired'] = clone(cat.nodes['model.shop.fct_revenue']);
    const m = clone(manifest);
    m.metadata!.dbt_schema_version = 'https://schemas.getdbt.com/dbt/manifest/v9.json';
    const { warnings, schema: s } = parseDbtArtifacts({ manifest: m, catalog: cat });
    expect(warnings.some((w) => w.includes('model.shop.retired'))).toBe(true);
    expect(warnings.some((w) => w.includes('v9'))).toBe(true);
    expect(s.tables.map((t) => t.name)).not.toContain('retired');
  });
});
