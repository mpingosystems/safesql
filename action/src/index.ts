import { readFileSync } from 'node:fs';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import {
  anyFailing,
  dbtContextBanner,
  exitCodeFor,
  modelNameFromFilename,
  prepareDbtContext,
  summaryTable,
  validateSqlSource,
  validateSqlWithDbt,
  type CliDialect,
  type DbtRunContext,
  type FileResult,
} from '../../src/services/fileValidation';
import { readDbtTarget } from '../../cli/dbtTarget';
import {
  buildReviewBody,
  parseAddedLines,
  planComments,
  type ReviewComment,
} from '../../src/services/prReview';
import type { ValidationIssue } from '../../src/types/validation';

// Thin GitHub Action wrapper around the shared SafeSQL engine. Validator logic
// is imported from src/services/ — never duplicated here.
//
// Two modes:
//   validate   (default) — glob SQL files, validate, write a job summary
//   pr-review            — validate only the SQL files changed in the PR and
//                          post inline review comments on the diff

// Prepared once per run when `dbt_target` is set; undefined otherwise.
function loadDbtContext(): DbtRunContext | undefined {
  const dir = core.getInput('dbt_target');
  if (!dir) return undefined;
  const dbt = prepareDbtContext(readDbtTarget(dir, 'dbt_target'));
  for (const w of dbt.warnings) core.warning(`SafeSQL dbt: ${w}`);
  core.info(dbtContextBanner(dbt.context));
  return dbt;
}

// One validation call that picks the dbt path when context is loaded. The
// model name comes from the file's basename (dbt's rule) and is only used when
// the manifest knows it.
function validateFile(sql: string, filename: string, schemaSql: string | undefined, dialect: CliDialect, dbt?: DbtRunContext) {
  if (!dbt) return validateSqlSource(sql, schemaSql, dialect);
  return validateSqlWithDbt(sql, dbt, schemaSql, dialect, undefined, modelNameFromFilename(filename, dbt.context));
}

async function runValidate(): Promise<void> {
  const pattern = core.getInput('sql_files') || '**/*.sql';
  const schemaFile = core.getInput('schema_file');
  const dialect = (core.getInput('dialect') || 'postgresql') as CliDialect;
  const failOnWarnings = core.getInput('fail_on_warnings') === 'true';

  const schemaSql = schemaFile ? readFileSync(schemaFile, 'utf8') : undefined;
  const dbt = loadDbtContext();

  const globber = await glob.create(pattern);
  const files = await globber.glob();

  const results: FileResult[] = [];
  let totalIssues = 0;
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const report = validateFile(sql, file, schemaSql, dialect, dbt);
    results.push({ filename: file, report });
    totalIssues += report.errors.length + report.warnings.length;
  }

  const summary = core.summary.addHeading('SafeSQL validation');
  if (dbt) summary.addRaw('\n' + dbtContextBanner(dbt.context) + '\n\n');
  await summary.addRaw('\n' + summaryTable(results) + '\n').write();

  core.setOutput('issues_found', String(totalIssues));
  core.setOutput('files_checked', String(files.length));

  if (anyFailing(results, failOnWarnings)) {
    const n = results.filter((r) => exitCodeFor(r.report, failOnWarnings) !== 0).length;
    core.setFailed(`SafeSQL found issues in ${n} file(s)`);
  }
}

async function runPrReview(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.warning('mode: pr-review requires a pull_request event — falling back to validate mode.');
    await runValidate();
    return;
  }

  const token = core.getInput('github_token');
  if (!token) {
    core.setFailed('mode: pr-review requires `github_token` (usually ${{ secrets.GITHUB_TOKEN }}).');
    return;
  }

  const schemaFile = core.getInput('schema_file');
  const dialect = (core.getInput('dialect') || 'postgresql') as CliDialect;
  const failOnWarnings = core.getInput('fail_on_warnings') === 'true';
  // block  → failed check, merge blocked
  // warn   → comments posted, check stays green
  const blocking = (core.getInput('comment_mode') || 'block') !== 'warn';

  const schemaSql = schemaFile ? readFileSync(schemaFile, 'utf8') : undefined;
  const dbt = loadDbtContext();
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const changed = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const sqlFiles = changed.filter(
    (f) => f.filename.toLowerCase().endsWith('.sql') && f.status !== 'removed',
  );
  if (sqlFiles.length === 0) {
    core.info('SafeSQL: no changed .sql files in this PR.');
    core.setOutput('issues_found', '0');
    core.setOutput('files_checked', '0');
    return;
  }

  const results: FileResult[] = [];
  const comments: ReviewComment[] = [];
  const unanchored: Array<{ path: string; issue: ValidationIssue }> = [];
  const summaryRows: Array<{ path: string; score: number; issueCount: number }> = [];
  let totalIssues = 0;

  for (const file of sqlFiles) {
    let sql: string;
    try {
      sql = readFileSync(file.filename, 'utf8');
    } catch {
      core.warning(`SafeSQL: could not read ${file.filename} from the workspace — skipped.`);
      continue;
    }
    const report = validateFile(sql, file.filename, schemaSql, dialect, dbt);
    results.push({ filename: file.filename, report });

    const issueCount = report.errors.length + report.warnings.length;
    totalIssues += issueCount;
    summaryRows.push({ path: file.filename, score: report.riskScore, issueCount });

    const plan = planComments(file.filename, sql, report, parseAddedLines(file.patch));
    comments.push(...plan.inline);
    unanchored.push(...plan.unanchored);
  }

  const failing = anyFailing(results, failOnWarnings);
  const body = buildReviewBody(summaryRows, unanchored, blocking && failing);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pr.number,
      event: 'COMMENT',
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
    core.info(`SafeSQL: posted ${comments.length} inline comment(s).`);
  } catch (e: unknown) {
    // Fork PRs get a read-only GITHUB_TOKEN, so this 403s for exactly the
    // contributors the feedback is most useful to. Degrade to the job summary
    // rather than failing the run for a permissions reason.
    const msg = e instanceof Error ? e.message : String(e);
    core.warning(
      `SafeSQL: could not post the review (${msg}). This is expected on pull requests from forks, ` +
        'where GITHUB_TOKEN is read-only. Falling back to the job summary.',
    );
  }

  await core.summary.addHeading('SafeSQL PR review').addRaw('\n' + body + '\n').write();

  core.setOutput('issues_found', String(totalIssues));
  core.setOutput('files_checked', String(results.length));

  if (failing && blocking) {
    core.setFailed(`SafeSQL found issues in ${summaryRows.filter((r) => r.issueCount > 0).length} file(s)`);
  }
}

export async function run(): Promise<void> {
  const mode = (core.getInput('mode') || 'validate').trim();
  if (mode === 'pr-review') {
    await runPrReview();
    return;
  }
  if (mode !== 'validate') {
    core.warning(`Unknown mode "${mode}" — expected "validate" or "pr-review". Using validate.`);
  }
  await runValidate();
}

run().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
