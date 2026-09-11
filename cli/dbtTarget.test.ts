import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDbtTarget } from './dbtTarget';
import { runValidation } from '../src/services/fileValidation';

// Sprint 8 Part 3 — test 17: `safesql validate --dbt-target <dir>` reads the
// artifacts from disk (the one piece of the CLI path that fileValidation's own
// tests cannot cover, because the engine is pure). Lives beside the reader,
// outside tsconfig.app.json's `src` include, so the app build never needs Node
// types.

const FIXTURE_DIR = join(__dirname, '..', 'src', 'services', '__fixtures__', 'dbt');

describe('17. CLI --dbt-target reads artifacts', () => {
  it('reads manifest.json plus optional catalog.json and run_results.json', () => {
    const input = readDbtTarget(FIXTURE_DIR);
    expect(input.manifest).toMatchObject({ metadata: { dbt_version: '1.8.4' } });
    expect(input.catalog).toBeDefined();
    expect(input.runResults).toBeDefined();
    // and drives the engine exactly as the CLI passes it through RunOptions
    const { report, output } = runValidation({ sql: 'SELECT SUM(revenue) FROM fct_revenue', dbtArtifacts: input, filename: 'q.sql' });
    expect(report.warnings.map((w) => w.id)).toContain('FINANCE_TAG_UNVALIDATED');
    expect(output).toContain('Models: 4 | Sources: 2 | Finance-tagged: 1');
  });

  it('works with a manifest alone — catalog and run_results are optional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'safesql-dbt-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ nodes: {}, sources: {} }));
    const input = readDbtTarget(dir);
    expect(input).toEqual({ manifest: { nodes: {}, sources: {} } });
    const { output } = runValidation({ sql: 'SELECT 1', dbtArtifacts: input, json: true });
    expect(JSON.parse(output).dbtContext.artifacts).toEqual({ catalog: false, runResults: false });
  });

  it('fails readably when manifest.json is missing or is not a manifest', () => {
    expect(() => readDbtTarget(join(FIXTURE_DIR, '..'))).toThrow(/--dbt-target: no manifest\.json/);
    const dir = mkdtempSync(join(tmpdir(), 'safesql-dbt-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ results: [] }));
    expect(() => readDbtTarget(dir)).toThrow(/not a dbt manifest/);
    // the Action reports the same failure under its own input name
    expect(() => readDbtTarget(dir, 'dbt_target')).toThrow(/^dbt_target:/);
  });
});
