import { describe, expect, it } from 'vitest';
import manifestJson from '../services/__fixtures__/dbt/manifest.json';
import catalogJson from '../services/__fixtures__/dbt/catalog.json';
import runResultsJson from '../services/__fixtures__/dbt/run_results.json';
import {
  dbtContextBanner,
  modelNameFromFilename,
  prepareDbtContext,
  runValidation,
  summarizeDbtContext,
  validateSqlWithDbt,
} from '../services/fileValidation';
import { handleValidate, MAX_BODY_BYTES, type ValidateDeps } from '../../functions/api/validate';
import { SafeSQLClient } from '../../sdk/src';
import type { DbtArtifactInput, DbtCatalog, DbtManifest, DbtRunResults } from '../services/dbtArtifacts';

// Sprint 8 Part 3 — delivery surfaces. The engine and parser are covered in
// dbt_artifacts.test.ts / dbt_context_detectors.test.ts; these tests prove the
// artifacts reach the engine through each surface and that the non-dbt paths
// are byte-for-byte what they were.

const manifest = manifestJson as unknown as DbtManifest;
const catalog = catalogJson as unknown as DbtCatalog;
const runResults = runResultsJson as unknown as DbtRunResults;
const artifacts: DbtArtifactInput = { manifest, catalog, runResults };

const RAW_SQL = 'SELECT id, amount FROM orders';
const FINANCE_SQL = 'SELECT SUM(revenue) FROM fct_revenue';

describe('fileValidation — dbt path', () => {
  it('runValidation with dbtArtifacts prefixes the banner and passes context to the engine', () => {
    const { report, output, exitCode } = runValidation({ sql: RAW_SQL, dbtArtifacts: artifacts, filename: 'adhoc.sql' });
    expect(report.warnings.map((w) => w.id)).toContain('UNAPPROVED_SOURCE');
    expect(output.startsWith('SafeSQL Guard — dbt manifest context loaded\nModels: 4 | Sources: 2 | Finance-tagged: 1\n')).toBe(true);
    expect(output).toContain('adhoc.sql — score ');
    expect(exitCode).toBe(0); // warning only; no --fail-on-warnings
  });

  it('JSON output carries dbtContext provenance instead of the banner', () => {
    const { output } = runValidation({ sql: RAW_SQL, dbtArtifacts: artifacts, json: true });
    const parsed = JSON.parse(output);
    expect(parsed.dbtContext).toEqual({
      models: 4, sources: 2, sensitiveTagged: 1, artifacts: { catalog: true, runResults: true }, warnings: [],
    });
    expect(output).not.toContain('manifest context loaded');
  });

  it('the non-dbt path is unchanged: no banner, no dbtContext, no Sprint 8 findings', () => {
    const { report, output } = runValidation({ sql: RAW_SQL, filename: 'adhoc.sql' });
    expect(output.startsWith('adhoc.sql — score ')).toBe(true);
    expect(report.warnings.map((w) => w.id)).not.toContain('UNAPPROVED_SOURCE');
    const json = JSON.parse(runValidation({ sql: RAW_SQL, json: true }).output);
    expect(json).not.toHaveProperty('dbtContext');
  });

  it('modelNameFromFilename applies dbt\'s basename rule and ignores names the manifest does not know', () => {
    const { context } = prepareDbtContext(artifacts);
    expect(modelNameFromFilename('models/staging/stg_orders.sql', context)).toBe('stg_orders');
    expect(modelNameFromFilename('C:\\repo\\models\\marts\\fct_revenue.sql', context)).toBe('fct_revenue');
    expect(modelNameFromFilename('STG_ORDERS.SQL', context)).toBe('stg_orders'); // case-insensitive lookup, canonical name back
    expect(modelNameFromFilename('scratch/adhoc.sql', context)).toBeUndefined();
    expect(modelNameFromFilename(undefined, context)).toBeUndefined();
  });

  it('a file named after the staging model gets the structural exemption through runValidation', () => {
    const staged = runValidation({ sql: RAW_SQL, dbtArtifacts: artifacts, filename: 'models/staging/stg_orders.sql' });
    expect(staged.report.warnings.map((w) => w.id)).not.toContain('UNAPPROVED_SOURCE');
    const mart = runValidation({ sql: RAW_SQL, dbtArtifacts: artifacts, filename: 'models/marts/fct_revenue.sql' });
    expect(mart.report.warnings.map((w) => w.id)).toContain('UNAPPROVED_SOURCE');
  });

  it('an explicit DDL wins per table over the artifact schema (validateSqlWithDbt)', () => {
    const dbt = prepareDbtContext(artifacts);
    // The user's DDL says fct_revenue has only these two columns → order_date is now hallucinated.
    const ddl = 'CREATE TABLE fct_revenue (order_id INT PRIMARY KEY, revenue NUMERIC);';
    const r = validateSqlWithDbt('SELECT order_date FROM fct_revenue', dbt, ddl);
    expect(r.errors.map((e) => e.id)).toContain('HALLUCINATED_COLUMN');
    // …while artifact-only tables are still known.
    const r2 = validateSqlWithDbt('SELECT order_status FROM stg_orders', dbt, ddl);
    expect(r2.errors.map((e) => e.id)).not.toContain('HALLUCINATED_TABLE');
    expect(r2.errors.map((e) => e.id)).not.toContain('HALLUCINATED_COLUMN');
  });

  it('summarizeDbtContext counts unique relations even when aliases register extra keys', () => {
    const m = JSON.parse(JSON.stringify(manifest)) as DbtManifest;
    m.nodes['model.shop.fct_revenue'].alias = 'revenue_facts';
    const { context } = prepareDbtContext({ manifest: m });
    expect(context.models.size).toBe(5); // 4 models + 1 alias key
    expect(summarizeDbtContext(context).models).toBe(4);
    expect(dbtContextBanner(context)).toBe('SafeSQL Guard — dbt manifest context loaded\nModels: 4 | Sources: 2 | Finance-tagged: 1');
  });
});

describe('18. REST API dbt field', () => {
  const deps: ValidateDeps = {
    authenticate: async () => ({ ok: true, plan: 'pro', userId: 'u1' }),
    checkUsage: async () => ({ ok: true }),
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleValidate(
      new Request('https://safesqlpro.dev/api/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer ssk_live_test', 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      deps,
    );

  it('parses dbt artifacts, runs the Sprint 8 detectors and returns dbtContext provenance', async () => {
    const res = await post({ sql: RAW_SQL, dbt: { manifest, catalog, runResults } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.warnings.map((w: { id: string }) => w.id)).toContain('UNAPPROVED_SOURCE');
    expect(json.dbtContext).toEqual({
      models: 4, sources: 2, sensitiveTagged: 1, artifacts: { catalog: true, runResults: true }, warnings: [],
    });
    expect(json.tier).toBe('pro');
    expect(json.detectorsRun).toHaveLength(35);
  });

  it('honours currentModel and sensitiveTags from the body', async () => {
    const exempt = await (await post({ sql: RAW_SQL, dbt: { manifest, currentModel: 'stg_orders' } })).json();
    expect(exempt.warnings.map((w: { id: string }) => w.id)).not.toContain('UNAPPROVED_SOURCE');
    const retagged = await (await post({ sql: FINANCE_SQL, dbt: { manifest, runResults, sensitiveTags: ['gdpr'] } })).json();
    expect(retagged.warnings.map((w: { id: string }) => w.id)).not.toContain('FINANCE_TAG_UNVALIDATED');
    expect(retagged.dbtContext.sensitiveTagged).toBe(0);
  });

  it('free tier withholds the Sprint 8 detectors and never reports the gated ids', async () => {
    const freeDeps: ValidateDeps = { ...deps, authenticate: async () => ({ ok: true, plan: 'free', userId: 'u2' }) };
    const res = await handleValidate(
      new Request('https://safesqlpro.dev/api/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
        body: JSON.stringify({ sql: RAW_SQL, dbt: { manifest } }),
      }),
      freeDeps,
    );
    const json = await res.json();
    expect(json.tier).toBe('free');
    expect(json.warnings.map((w: { id: string }) => w.id)).not.toContain('UNAPPROVED_SOURCE');
    expect(json.upgradePrompt).toContain('35');
  });

  it('rejects a malformed dbt payload with 400, not 500', async () => {
    const res = await post({ sql: RAW_SQL, dbt: { manifest: { results: [] } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dbt\.manifest/);
    const res2 = await post({ sql: RAW_SQL, dbt: 'nope' });
    expect(res2.status).toBe(400);
  });

  it('a request without dbt is handled exactly as before', async () => {
    const json = await (await post({ sql: RAW_SQL })).json();
    expect(json).not.toHaveProperty('dbtContext');
    expect(json.warnings.map((w: { id: string }) => w.id)).not.toContain('UNAPPROVED_SOURCE');
  });

  it('enforces the 25 MB cap on Content-Length and on the bytes actually read (413)', async () => {
    expect(MAX_BODY_BYTES).toBe(25 * 1024 * 1024);
    const declared = await post({ sql: RAW_SQL }, { 'content-length': String(MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);
    expect((await declared.json()).error).toBe('Request body exceeds 25 MB limit');
    // Chunked-style: no trustworthy Content-Length, body genuinely oversized.
    const padding = 'x'.repeat(MAX_BODY_BYTES + 16);
    const oversized = await post(`{"sql":"${RAW_SQL}","pad":"${padding}"}`, { 'content-length': '10' });
    expect(oversized.status).toBe(413);
  });
});

describe('SDK dbt passthrough', () => {
  it('sends the dbt field only when given, and maps dbtContext back', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          riskScore: 60, processingMs: 1, errors: [], warnings: [], suggestions: [], tier: 'pro',
          dbtContext: { models: 4, sources: 2, sensitiveTagged: 1, artifacts: { catalog: true, runResults: false }, warnings: ['w'] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = new SafeSQLClient({ apiKey: 'ssk_live_x', fetch: fetchImpl });
    const withDbt = await client.validate({ sql: RAW_SQL, dbt: { manifest, currentModel: 'stg_orders' } });
    expect(calls[0].body).toMatchObject({ sql: RAW_SQL, dbt: { currentModel: 'stg_orders' } });
    expect(withDbt.dbtContext).toEqual({
      models: 4, sources: 2, sensitiveTagged: 1, artifacts: { catalog: true, runResults: false }, warnings: ['w'],
    });
    await client.validate({ sql: RAW_SQL });
    expect(calls[1].body).not.toHaveProperty('dbt');
  });
});
