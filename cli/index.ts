#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { runValidation, verdictFor, type CliDialect } from '../src/services/fileValidation';
import type { DbtArtifactInput } from '../src/services/dbtArtifacts';
import { readDbtTarget } from './dbtTarget';

// Thin CLI wrapper around the shared SafeSQL engine (src/services/). The
// validator logic is NOT duplicated here — this only reads files, formats
// output, and sets the exit code.

const program = new Command();

program
  .name('safesql')
  .description('Pre-execution semantic SQL validation')
  .version('0.10.0');

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

program.parse();
