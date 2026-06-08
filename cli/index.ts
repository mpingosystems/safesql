#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { runValidation, verdictFor, type CliDialect } from '../src/services/fileValidation';

// Thin CLI wrapper around the shared SafeSQL engine (src/services/). The
// validator logic is NOT duplicated here — this only reads files, formats
// output, and sets the exit code.

const program = new Command();

program
  .name('safesql')
  .description('Pre-execution semantic SQL validation')
  .version('0.4.0');

program
  .command('validate <file>')
  .description('Validate a SQL file for semantic errors')
  .option('--schema <file>', 'DDL schema file for column validation')
  .option('--dialect <dialect>', 'postgresql | mysql | bigquery | snowflake', 'postgresql')
  .option('--json', 'Machine-readable JSON output')
  .option('--fail-on-warnings', 'Exit 1 on warnings too (default: only errors)')
  .action((file: string, options: { schema?: string; dialect?: string; json?: boolean; failOnWarnings?: boolean }) => {
    const sql = readFileSync(file, 'utf8');
    const schemaSql = options.schema ? readFileSync(options.schema, 'utf8') : undefined;
    const { report, output, exitCode } = runValidation({
      sql,
      schemaSql,
      dialect: (options.dialect as CliDialect) ?? 'postgresql',
      json: options.json,
      failOnWarnings: options.failOnWarnings,
      filename: file,
    });

    if (options.json) {
      console.log(output);
    } else {
      const verdict = verdictFor(report.riskScore);
      const colour =
        verdict === 'RISKY' ? chalk.red : verdict === 'REVIEW' ? chalk.yellow : chalk.green;
      console.log(colour(`${file} — score ${report.riskScore} [${verdict}]`));
      // Print the body (minus the first verdict line, which we just coloured).
      console.log(output.split('\n').slice(1).join('\n'));
    }

    process.exit(exitCode);
  });

program.parse();
