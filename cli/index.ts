#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { runValidation, verdictFor, type CliDialect } from '../src/services/fileValidation';
import type { DbtArtifactInput } from '../src/services/dbtArtifacts';
import { TOTAL_DETECTORS as DETECTOR_COUNT } from '../src/config/detectorTiers';
import { readDbtTarget } from './dbtTarget';
import {
  SIGN_NEEDS_KEY_WARNING,
  discoverSqlFiles,
  formatReport,
  requestSignedBundle,
  runBatchScan,
  type ReportFormat,
} from './batchScan';

// Thin CLI wrapper around the shared SafeSQL engine (src/services/). The
// validator logic is NOT duplicated here — this only reads files, formats
// output, and sets the exit code.

const CLI_VERSION = '0.11.0';
const program = new Command();

program
  .name('safesql')
  .description('Pre-execution semantic SQL validation')
  .version(CLI_VERSION);

program
  .command('validate <file>')
  .description('Validate a SQL file for semantic errors')
  .option('--schema <file>', 'DDL schema file for column validation')
  .option(
    '--dbt-target <dir>',
    'dbt target/ directory: reads manifest.json (required), catalog.json and run_results.json (optional)',
  )
  .option('--dialect <dialect>', 'postgresql | mysql | bigquery | snowflake', 'postgresql')
  .option('--json', 'Machine-readable JSON output')
  .option('--fail-on-warnings', 'Exit 1 on warnings too (default: only errors)')
  .action((file: string, options: { schema?: string; dbtTarget?: string; dialect?: string; json?: boolean; failOnWarnings?: boolean }) => {
    const sql = readFileSync(file, 'utf8');
    const schemaSql = options.schema ? readFileSync(options.schema, 'utf8') : undefined;
    let dbtArtifacts: DbtArtifactInput | undefined;
    if (options.dbtTarget) {
      try {
        dbtArtifacts = readDbtTarget(options.dbtTarget);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(2);
      }
    }
    const { report, output, exitCode } = runValidation({
      sql,
      schemaSql,
      dialect: (options.dialect as CliDialect) ?? 'postgresql',
      json: options.json,
      failOnWarnings: options.failOnWarnings,
      filename: file,
      dbtArtifacts,
    });

    if (options.json) {
      console.log(output);
    } else {
      const verdict = verdictFor(report.riskScore);
      const colour =
        verdict === 'RISKY' ? chalk.red : verdict === 'REVIEW' ? chalk.yellow : chalk.green;
      // With --dbt-target the output starts with a two-line context banner;
      // print it dim, then colour the verdict line, then the body.
      const lines = output.split('\n');
      const verdictAt = lines.findIndex((l) => l.startsWith(`${file} — score `));
      const bannerLines = verdictAt > 0 ? lines.slice(0, verdictAt) : [];
      for (const l of bannerLines) console.log(chalk.dim(l));
      console.log(colour(`${file} — score ${report.riskScore} [${verdict}]`));
      // Print the body (minus the banner + verdict line, which we just printed).
      console.log(lines.slice(Math.max(verdictAt, 0) + 1).join('\n'));
    }

    process.exit(exitCode);
  });

// ── Sprint 9.5A-pre — batch scan (SQL Health Check) ──────────────────────────
// Progress goes to stderr, the report to stdout or --output, so a redirected
// report is never polluted. The engine is the same one `validate` uses.
program
  .command('scan')
  .description('Scan a directory of .sql files and produce one consolidated health-check report')
  .requiredOption('--dir <path>', 'Directory to scan recursively for .sql files and dbt models')
  .option('--dialect <dialect>', 'postgresql | mysql | bigquery | snowflake', 'postgresql')
  .option('--format <format>', 'markdown | json | text', 'markdown')
  .option('--output <file>', 'Write the report to a file (default: stdout)')
  .option('--threshold <n>', 'Only report files scoring below n (default 100 — report all issues)', '100')
  .option('--dbt-target <dir>', 'dbt target/ directory for manifest context')
  .option('--api-key <key>', 'SafeSQL Pro API key — enables Pro detectors and chain logging')
  .option('--sign', 'Generate a signed evidence bundle alongside the report (requires --api-key)')
  .option('--exclude <pattern>', 'Glob pattern to exclude files (e.g. "**/*.test.sql")')
  .action(async (o: { dir: string; dialect: string; format: string; output?: string; threshold: string; dbtTarget?: string; apiKey?: string; sign?: boolean; exclude?: string }) => {
    const err = (l: string) => process.stderr.write(l + '\n');
    const format = o.format as ReportFormat;
    if (!['markdown', 'json', 'text'].includes(format)) {
      err(chalk.red(`--format must be markdown, json or text (got "${o.format}")`));
      process.exit(2);
    }
    const threshold = Number(o.threshold);
    if (!Number.isFinite(threshold)) {
      err(chalk.red(`--threshold must be a number (got "${o.threshold}")`));
      process.exit(2);
    }
    let dbtArtifacts: DbtArtifactInput | undefined;
    if (o.dbtTarget) {
      try {
        dbtArtifacts = readDbtTarget(o.dbtTarget);
      } catch (e) {
        err(chalk.red((e as Error).message));
        process.exit(2);
      }
    }
    if (o.sign && !o.apiKey) err(chalk.yellow(SIGN_NEEDS_KEY_WARNING));

    const startedAt = new Date();
    const files = discoverSqlFiles(o.dir, o.exclude);
    const result = await runBatchScan(files, {
      dir: o.dir,
      dialect: o.dialect as CliDialect,
      threshold,
      dbtArtifacts,
      apiKey: o.apiKey,
      progress: err,
    });

    if (o.sign && o.apiKey) {
      const signed = await requestSignedBundle({ apiKey: o.apiKey, periodFrom: startedAt, periodTo: new Date() });
      if (signed.ok && signed.bytes && signed.filename && signed.bundleHash) {
        const zipPath = join(o.output ? dirname(resolve(o.output)) : process.cwd(), signed.filename);
        writeFileSync(zipPath, signed.bytes);
        result.bundle_hash = signed.bundleHash;
        err(`Evidence bundle: ${signed.bundleHash}`);
        err(`Bundle written to ${zipPath}`);
      } else {
        err(chalk.yellow(`Evidence bundle not generated: ${signed.error ?? 'unknown error'}`));
      }
    }

    const report = formatReport(result, format, { appVersion: CLI_VERSION, detectorCount: DETECTOR_COUNT });
    if (o.output) {
      // BOM-free UTF-8: Node never writes a BOM for 'utf8'.
      writeFileSync(o.output, report, 'utf8');
      err(`Report written to ${resolve(o.output)}`);
    } else {
      process.stdout.write(report);
    }
    process.exit(result.summary.critical_count > 0 ? 1 : 0);
  });

program.parse();
