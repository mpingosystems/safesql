import { readFileSync } from 'node:fs';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import {
  anyFailing,
  exitCodeFor,
  summaryTable,
  validateSqlSource,
  type CliDialect,
  type FileResult,
} from '../../src/services/fileValidation';

// Thin GitHub Action wrapper around the shared SafeSQL engine. Validator logic
// is imported from src/services/ — never duplicated here.

export async function run(): Promise<void> {
  const pattern = core.getInput('sql_files') || '**/*.sql';
  const schemaFile = core.getInput('schema_file');
  const dialect = (core.getInput('dialect') || 'postgresql') as CliDialect;
  const failOnWarnings = core.getInput('fail_on_warnings') === 'true';

  const schemaSql = schemaFile ? readFileSync(schemaFile, 'utf8') : undefined;

  const globber = await glob.create(pattern);
  const files = await globber.glob();

  const results: FileResult[] = [];
  let totalIssues = 0;
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const report = validateSqlSource(sql, schemaSql, dialect);
    results.push({ filename: file, report });
    totalIssues += report.errors.length + report.warnings.length;
  }

  await core.summary
    .addHeading('SafeSQL validation')
    .addRaw('\n' + summaryTable(results) + '\n')
    .write();

  core.setOutput('issues_found', String(totalIssues));
  core.setOutput('files_checked', String(files.length));

  if (anyFailing(results, failOnWarnings)) {
    const n = results.filter((r) => exitCodeFor(r.report, failOnWarnings) !== 0).length;
    core.setFailed(`SafeSQL found issues in ${n} file(s)`);
  }
}

run().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
