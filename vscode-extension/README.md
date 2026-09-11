# SafeSQL Pro for VS Code

**Semantic SQL validation — catches the logic errors linters miss.**

> SQL that runs is the most dangerous SQL. It doesn't crash. It returns wrong
> numbers that drive real decisions.

SQLFluff checks style. SafeSQL Pro checks logic. On save, this extension
validates the active `.sql` file against 35 deterministic detectors and
underlines the offending clause — before the query ever reaches your warehouse.

![shield](icon.png)

## What it catches

- `AGGREGATE_OVER_FANOUT_JOIN` — a JOIN multiplies rows before `SUM()`
- `LEFT_JOIN_FILTERED_IN_WHERE` — a WHERE clause silently turns a LEFT JOIN into an INNER JOIN
- `CARTESIAN_JOIN`, `MISSING_WHERE_DESTRUCTIVE`, `INCOMPLETE_GROUP_BY`
- `HALLUCINATED_TABLE` / unknown columns (when a schema file is configured)
- …and 28 more. Deterministic AST rules — no AI in the detection path, so no
  hallucinated warnings.

## Features

| | |
|---|---|
| **Validate on save** | Every `.sql` save is checked (toggle with `safesql.validateOnSave`) |
| **Inline diagnostics** | Squiggles on the offending column/table/clause |
| **Hover detail** | Issue type, plain-English message, concrete fix, score impact |
| **Status bar** | `SafeSQL: 25 CRITICAL` — click to re-validate |
| **Schema-aware** | Point `safesql.schemaFile` at your DDL to unlock column checks |

## Setup

1. Get an API key at [safesqlpro.dev/settings](https://safesqlpro.dev/settings).
2. Set `safesql.apiKey` in VS Code settings — or export `SAFESQL_PRO_API_KEY`,
   which takes precedence and keeps the key out of `settings.json`.
3. Save a `.sql` file.

Without a key the extension does **not** fail — it shows a one-time prompt with
**Open Settings** and **Get an API key**, and stays quiet after that.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `safesql.apiKey` | — | SafeSQL Pro API key |
| `safesql.threshold` | `70` | Score below which validation is failing (0–100) |
| `safesql.dialect` | `postgresql` | `postgresql` \| `mysql` \| `bigquery` \| `snowflake` |
| `safesql.validateOnSave` | `true` | Validate automatically on save |
| `safesql.schemaFile` | — | DDL file, relative to the workspace root |
| `safesql.baseUrl` | — | Override the API origin |

## Verdict bands

| Score | Verdict | Meaning |
|-------|---------|---------|
| 0–40 | `CRITICAL` | Hard error — unknown column/table, cartesian, destructive |
| 41–69 | `RISKY` | High-risk semantic warning — fan-out, LEFT JOIN in WHERE |
| 70–84 | `REVIEW` | Medium warning — integer division, COUNT after join |
| 85–100 | `CLEAN` | Suggestions only |

## Build the .vsix

```bash
cd sdk && npm install && npm run build       # the extension depends on the SDK
cd ../vscode-extension
npm install
npm run package                              # → safesql-pro-0.1.0.vsix
code --install-extension safesql-pro-0.1.0.vsix
```

Publish (requires the `mpingosystems` publisher account):

```bash
npx @vscode/vsce publish
```

## Also available

- CLI — `npx safesql validate query.sql`
- GitHub Action — `mpingosystems/safesql@v1`
- pre-commit hook — `safesql-sql`
- dbt — `pip install dbt-safesql`
- SDK — `npm install @safesqlpro/sdk`

Apache-2.0 © Mpingo Systems LLC
