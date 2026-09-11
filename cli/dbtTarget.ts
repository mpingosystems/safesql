import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeDbtManifest, type DbtArtifactInput } from '../src/services/dbtArtifacts';

// Sprint 8 (dbt): read a dbt target/ directory. manifest.json is required;
// catalog.json and run_results.json are used when present. The parser
// (src/services/dbtArtifacts.ts) is pure — file I/O lives here, shared by the
// CLI (--dbt-target) and the GitHub Action (dbt_target).

export const DBT_ARTIFACT_FILES = {
  manifest: 'manifest.json',
  catalog: 'catalog.json',
  runResults: 'run_results.json',
} as const;

export function readDbtTarget(dir: string, flag = '--dbt-target'): DbtArtifactInput {
  const manifestPath = join(dir, DBT_ARTIFACT_FILES.manifest);
  if (!existsSync(manifestPath)) {
    throw new Error(`${flag}: no manifest.json in ${dir} (run \`dbt compile\` or \`dbt run\` first)`);
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!looksLikeDbtManifest(manifest)) {
    throw new Error(`${flag}: ${manifestPath} is not a dbt manifest (no \`nodes\` map)`);
  }
  const optional = (name: string): unknown => {
    const p = join(dir, name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
  };
  const catalog = optional(DBT_ARTIFACT_FILES.catalog) as DbtArtifactInput['catalog'];
  const runResults = optional(DBT_ARTIFACT_FILES.runResults) as DbtArtifactInput['runResults'];
  return { manifest, ...(catalog ? { catalog } : {}), ...(runResults ? { runResults } : {}) };
}
