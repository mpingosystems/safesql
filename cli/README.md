# SafeSQL CLI

Pre-execution semantic SQL validation in your terminal. Thin wrapper around the
SafeSQL engine (`src/services/`) — same 33 detectors as the web editor.

## Install / build

```bash
cd cli
npm install
npm run build   # → cli/dist/index.js
```

## Usage

```bash
npx safesql validate query.sql
npx safesql validate query.sql --schema schema.sql --dialect snowflake
npx safesql validate query.sql --json          # machine-readable
npx safesql validate query.sql --fail-on-warnings
```

## Options

| Flag | Description |
|------|-------------|
| `--schema <file>`     | DDL schema file for column validation |
| `--dialect <dialect>` | `postgresql` \| `mysql` \| `bigquery` \| `snowflake` (default postgresql) |
| `--json`              | Machine-readable JSON (full `ValidationReport`) |
| `--fail-on-warnings`  | Exit 1 on warnings too (default: only errors) |

## CI usage

```bash
npx safesql validate src/queries/*.sql --schema schema.sql
```

Exit code: `1` if any error (or warning with `--fail-on-warnings`), else `0`.
