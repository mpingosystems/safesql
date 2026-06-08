# SafeSQL dbt Integration

Validate every dbt SQL model with SafeSQL **before** `dbt run` executes it.
SafeSQL and dbt are sequential, not competitors: SafeSQL validates the query
before execution; dbt tests validate the output after.

## Install

```bash
pip install requests pyyaml   # only deps
```

## Run standalone

```bash
export SAFESQL_API_KEY=ssk_live_xxxx
python validate_dbt.py --project-dir . --dialect postgresql
```

Or wire it into `dbt_project.yml` as a pre-run hook:

```yaml
on-run-start:
  - "python {{ project_dir }}/dbt-safesql/validate_dbt.py --project-dir {{ project_dir }}"
```

## What it does

- Scans `models/**/*.sql`
- Strips dbt Jinja (`{{ ref(...) }}`, `{% ... %}`) so the SQL parses
- Builds a rough DDL from `schema.yml` / `sources.yml` column definitions
- Calls `POST https://safesqlpro.dev/api/validate` for each model
- Prints a summary and **exits 1** if any model has errors (fails `dbt run`)

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project-dir`  | `.`         | dbt project root |
| `--profiles-dir` | `~/.dbt`    | dbt profiles dir |
| `--dialect`      | `postgresql`| SQL dialect |
| `--api-key`      | `$SAFESQL_API_KEY` | SafeSQL API key (Pro+) |

Get an API key at https://safesqlpro.dev/settings.
