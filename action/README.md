# SafeSQL GitHub Action

Block PRs containing semantically unsafe SQL. Same 33 detectors as the web
editor — runs entirely in CI, no network call required.

## Usage

```yaml
- uses: emkwambe/safesql@v1
  with:
    sql_files: "queries/**/*.sql"
    schema_file: "schema/production.sql"
    dialect: "postgresql"
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `sql_files`         | `**/*.sql`   | Glob of SQL files to validate |
| `schema_file`       | —            | DDL schema file (enables column-level detectors) |
| `dialect`           | `postgresql` | `postgresql` \| `mysql` \| `bigquery` \| `snowflake` |
| `fail_on_warnings`  | `false`      | Fail the job on warnings too (default: only errors) |
| `api_key`           | —            | SafeSQL API key (Pro/Team — AI explanations) |

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
