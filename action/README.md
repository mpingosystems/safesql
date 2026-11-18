# SafeSQL GitHub Action

Block PRs containing semantically unsafe SQL. Same 35 detectors as the web
editor — runs entirely in CI, no network call required.

## Usage

```yaml
- uses: mpingosystems/safesql@v1
  with:
    sql_files: "queries/**/*.sql"
    schema_file: "schema/production.sql"
    dialect: "postgresql"
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `mode`              | `validate`   | `validate` (glob files) \| `pr-review` (inline comments on changed SQL in a PR) |
| `github_token`      | —            | `pr-review` only: the workflow's `GITHUB_TOKEN` (needs `pull-requests: write`) |
| `comment_mode`      | `block`      | `pr-review` only: `block` (fail the check) \| `warn` (comment without blocking) |
| `sql_files`         | `**/*.sql`   | Glob of SQL files to validate |
| `schema_file`       | —            | DDL schema file (enables column-level detectors) |
| `dbt_target`        | —            | dbt `target/` directory with `manifest.json` (`catalog.json`, `run_results.json` used when present) |
| `dialect`           | `postgresql` | `postgresql` \| `mysql` \| `bigquery` \| `snowflake` |
| `fail_on_warnings`  | `false`      | Fail the job on warnings too (default: only errors) |

The action takes no API key: all 35 detectors run locally on the runner, and
your SQL never leaves it. (v0.11.3 removed an `api_key` input that was declared
but never read; delete it from your `with:` block.)

## Outputs

| Output | Description |
|--------|-------------|
| `issues_found`  | Total errors + warnings across all files |
| `files_checked` | Number of SQL files validated |

The action writes a markdown summary table to `$GITHUB_STEP_SUMMARY` and fails
the workflow (exit 1) when any file has errors (or warnings with
`fail_on_warnings: true`).

## Build

```bash
cd action
npm install
npm run build   # ncc bundle → action/dist/index.js (committed)
```
