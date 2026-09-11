# SafeSQL dbt Integration

Validate every dbt SQL model with SafeSQL **before** `dbt run` executes it.
SafeSQL and dbt are sequential, not competitors: SafeSQL validates the query
before execution; dbt tests validate the output after.

## Install

```bash
pip install dbt-safesql
```

That installs three console scripts and two dependencies (`requests`,
`pyyaml`). Python 3.9+.

| Command | |
|---|---|
| `dbt-safesql` | Primary. Project-wide, dbt-aware. Matches the package name. |
| `safesql-dbt` | Alias for the same command, kept from 0.2.0 so existing scripts and CI steps keep working. |
| `safesql-sql` | File-scoped, not dbt-aware — validates exactly the paths given. Used by the `safesql-sql` pre-commit hook. |

`dbt-safesql` and `safesql-dbt` are the same entry point; use either.

From a checkout instead:

```bash
pip install ./dbt-safesql
```

## Quick start

```bash
export SAFESQL_API_KEY=ssk_live_xxxx
dbt-safesql --project-dir . --dialect postgresql
```

Get an API key at https://safesqlpro.dev/settings (Pro tier and above).

## How enforcement works

**dbt hooks and macros cannot call SafeSQL.** dbt hooks (`on-run-start`,
`pre-hook`, `post-hook`) execute SQL against your warehouse, and dbt's Jinja
sandbox has no HTTP client — so no macro or hook can reach the SafeSQL API.
Enforcement runs *beside* dbt, in one of three places:

### 1. pre-commit (recommended)

Two hook ids are published from the repo root manifest. Pick the one that
matches your project:

```yaml
# .pre-commit-config.yaml — ordinary SQL repo (file-scoped)
repos:
  - repo: https://github.com/mpingosystems/safesql
    rev: dbt-safesql-v0.2.0
    hooks:
      - id: safesql-sql
        args: [--threshold=70, --dialect=postgres]
```

```yaml
# .pre-commit-config.yaml — dbt project (whole-project, dbt-aware)
repos:
  - repo: https://github.com/mpingosystems/safesql
    rev: dbt-safesql-v0.2.0
    hooks:
      - id: safesql-validate
        args: [--threshold=70]
```

| Hook id | Scope | Use when |
|---|---|---|
| `safesql-sql` | Validates exactly the staged `.sql` files | Any SQL repo |
| `safesql-validate` | Walks the whole dbt project (`models/**` + `schema.yml`), ignores staged paths | dbt projects, where a model's correctness depends on refs and column types declared elsewhere |

Both block the commit when something scores below the threshold; add
`--warn-only` to report without blocking.

`--dialect` accepts the short forms too — `postgres`, `pg`, `psql` and `bq` are
normalised to the engine's `postgresql` / `bigquery`.

> The manifest lives at the **repository root** (`.pre-commit-hooks.yaml`), as
> pre-commit requires, and the root `pyproject.toml` is a shim that pulls
> `dbt-safesql` from PyPI to provide the console scripts. Neither is part of the
> SafeSQL Pro web app build.

### 2. CI, or a shell step before dbt run

```bash
dbt-safesql --project-dir . --threshold 70 && dbt run
```

```yaml
# .github/workflows/dbt.yml
- run: pip install dbt-safesql
- run: dbt-safesql --project-dir . --threshold 70
  env:
    SAFESQL_API_KEY: ${{ secrets.SAFESQL_API_KEY }}
```

### 3. dbt_project.yml reminder hook

`dbt_project.yml` in this directory carries a reference `on-run-start` hook and
the `safesql_threshold` / `safesql_warn_only` vars. The hook **logs a reminder
only** — it cannot block the run. Copy the blocks into your own project:

```yaml
vars:
  safesql_threshold: 70
  safesql_warn_only: false

on-run-start:
  - "{{ log('SafeSQL: enforcement runs via `safesql-dbt --threshold=' ~ var('safesql_threshold', 70) ~ '` (pre-commit or CI) — dbt hooks cannot call it.', info=True) }}"
```

## What it does

- Scans `models/**/*.sql`
- Strips dbt Jinja (`{{ ref(...) }}`, `{% ... %}`) so the SQL parses
- Builds a rough DDL from `schema.yml` / `sources.yml` column definitions
- Calls `POST https://safesqlpro.dev/api/validate` for each model
- Prints a per-model score and **exits 1** if any model falls below the threshold

```
SafeSQL: 2 models checked, 2 failing (threshold 70)
  X integration_tests\models\test_cartesian.sql (score: 25, hard error) - 1 issue(s)
     CARTESIAN_JOIN: A JOIN without an ON (or USING) clause produces a Cartesian
     product: every row of the left side paired with every row of "orders".
       Fix: Add a join condition, e.g. JOIN orders ON ....
  X integration_tests\models\test_fanout.sql (score: 25, hard error) - 1 issue(s)
     AGGREGATE_OVER_FANOUT_JOIN: Joining "user_tags" alongside "orders" duplicates
     each "orders" row once per matching "user_tags" row, so SUM(total_amount) is
     multiplied.
       Fix: Pre-aggregate "orders" before joining.
SafeSQL: fix the issues above, or re-run with --warn-only to proceed.
```

Each failing model shows why it failed — `hard error` (the engine returned
errors, which fail at any threshold) or `score below N`. Models at or above the
threshold print as `OK <file> (score: N)`.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project-dir`  | `.`         | dbt project root |
| `--profiles-dir` | `~/.dbt`    | dbt profiles dir |
| `--dialect`      | `postgresql`| SQL dialect |
| `--api-key`      | `$SAFESQL_API_KEY` | SafeSQL API key (Pro+) |
| `--threshold`    | `70` (`$SAFESQL_THRESHOLD`) | Fail models scoring below this; models at or above it are not reported |
| `--warn-only`    | off (`$SAFESQL_WARN_ONLY`) | Print findings but always exit 0 |
| `--target-dir`   | `<project-dir>/target` (`$SAFESQL_DBT_TARGET`) | dbt `target/` directory; when `manifest.json` is there, the artifacts are sent instead of the schema.yml DDL |

### `--threshold`

Scores follow the SafeSQL score policy:

| Score | Meaning |
|---|---|
| 0–40 | Hard error (unknown column/table, cartesian join, destructive SQL) |
| 41–69 | High-risk semantic warning (fan-out aggregate, LEFT JOIN WHERE, SCD) |
| 70–84 | Medium warning (integer division, COUNT parent after join) |
| 85–100 | Suggestion only |

The default of `70` therefore fails on errors and high-risk warnings and stays
quiet above that. Raise it to `85` to also block medium warnings.

```bash
dbt-safesql --threshold 85     # stricter
dbt-safesql --threshold 41     # hard errors only
```

### `--warn-only`

Reports everything but exits 0, so it never blocks a commit or a build. Useful
when introducing SafeSQL to an existing project with a backlog of findings.

```bash
dbt-safesql --warn-only
```

### `--target-dir` (dbt artifacts)

After `dbt compile` / `dbt run` (and ideally `dbt docs generate`), the
`target/` directory holds `manifest.json`, `catalog.json` and
`run_results.json`. When a manifest is found, `dbt-safesql` sends those instead
of the DDL it would otherwise build from `schema.yml` — and gets a strictly
better schema for it: every column (not just the documented ones), real
warehouse types, and PK / FK / nullable derived from your `unique`, `not_null`
and `relationships` tests. Two detectors only run with artifacts:

- `UNAPPROVED_SOURCE` — a model reads a raw `source()` directly while a
  trusted (non-ephemeral) model built from that source exists. Staging models
  reading their own source are exempt; the exemption is structural (the model
  is downstream of the source and depends on it directly), not name-based.
- `FINANCE_TAG_UNVALIDATED` — a referenced relation is tagged `finance` or
  `pii` and its last run was not `success` (or it has no run result). The CLI
  prints `This query touches a model tagged finance - validation required
  before export` under the finding.

```bash
dbt run && dbt docs generate
dbt-safesql                              # finds ./target automatically
dbt-safesql --target-dir build/target    # elsewhere
safesql-sql --target-dir target models/marts/fct_revenue.sql   # file-scoped
```

Without a manifest the previous behaviour is unchanged (schema.yml DDL). The
request body is capped at 25 MB; a very large manifest can be trimmed with
`dbt compile --select <models>`.

## Integration tests

`integration_tests/` is a minimal dbt project with two deliberately broken
models:

| Model | Detector | Score |
|---|---|---|
| `test_fanout.sql` | `AGGREGATE_OVER_FANOUT_JOIN` | 25 |
| `test_cartesian.sql` | `CARTESIAN_JOIN` | 25 |

```bash
dbt-safesql --project-dir integration_tests --threshold 70   # exits 1
dbt-safesql --project-dir integration_tests --warn-only      # exits 0
```

It is never built with `dbt run` — `test_cartesian.sql` is intentionally
invalid SQL.

## Environment

| Variable | Purpose |
|---|---|
| `SAFESQL_API_KEY` | API key (same as `--api-key`) |
| `SAFESQL_API_URL` | Override the endpoint, e.g. `http://localhost:8788/api/validate` |
| `SAFESQL_THRESHOLD` | Default for `--threshold` |
| `SAFESQL_WARN_ONLY` | `1`/`true`/`yes` to default `--warn-only` on |
| `SAFESQL_DBT_TARGET` | Default for `--target-dir` |
