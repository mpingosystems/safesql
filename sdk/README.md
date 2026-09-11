# @safesqlpro/sdk

Official TypeScript SDK for [SafeSQL Pro](https://safesqlpro.dev) — pre-execution
semantic SQL validation.

> SQL that runs is the most dangerous SQL. It doesn't crash. It returns wrong
> numbers that drive real decisions.

The SDK is a thin, dependency-free wrapper around the SafeSQL Pro REST API
(`POST /api/validate`). It runs the same 35-detector engine that powers the web
editor, the CLI, the GitHub Action and the dbt integration.

## Install

```bash
npm install @safesqlpro/sdk
```

Get an API key at [safesqlpro.dev/settings](https://safesqlpro.dev/settings).

## Usage

### 1. Basic

```typescript
import { SafeSQLClient } from '@safesqlpro/sdk';

const client = new SafeSQLClient({ apiKey: process.env.SAFESQL_PRO_API_KEY! });

const result = await client.validate({
  sql: 'SELECT c.id, SUM(o.amount) FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.id',
});

console.log(result.score, result.verdict); // 25 'CRITICAL'

if (!result.valid) {
  for (const issue of result.issues) {
    console.error(`[${issue.issueType}] ${issue.message}`);
    if (issue.fix) console.log(`  fix: ${issue.fix}`);
  }
}
```

### 2. With a schema (DDL)

Passing DDL unlocks the schema-aware detectors — unknown columns, hallucinated
tables, integer division on INT columns, and fan-out detection from real
foreign keys.

```typescript
const ddl = `
  CREATE TABLE customers (id INT PRIMARY KEY, name TEXT);
  CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT REFERENCES customers(id), amount NUMERIC);
`;

const result = await client.validate({
  sql: 'SELECT customer_name FROM customers',
  ddl,
  dialect: 'postgresql',
});
```

### 3. With a threshold (CI gate)

`valid` is `score >= threshold`. The default threshold is `70`.

```typescript
const result = await client.validate({ sql, threshold: 85 });

if (!result.valid) {
  console.error(`SafeSQL score ${result.score} (${result.verdict}) — below 85`);
  process.exit(1);
}
```

### 4. With dbt artifacts

Pass parsed `target/manifest.json` (required), `catalog.json` and
`run_results.json` (optional). The schema is then derived from the artifacts —
complete column lists, warehouse types, PK/FK/nullable from the project's own
`unique` / `not_null` / `relationships` tests — and two dbt-aware detectors run:
`UNAPPROVED_SOURCE` (a raw source queried while a trusted mart exists) and
`FINANCE_TAG_UNVALIDATED` (a `finance` / `pii`-tagged relation whose last run
did not succeed). `currentModel` lets a staging model read its own raw source
without a finding. The request body is capped at 25 MB.

```typescript
import { readFileSync } from 'node:fs';

const read = (f: string) => JSON.parse(readFileSync(`target/${f}`, 'utf8'));

const result = await client.validate({
  sql,
  dbt: {
    manifest: read('manifest.json'),
    catalog: read('catalog.json'),       // optional
    runResults: read('run_results.json'), // optional
    currentModel: 'stg_orders',           // optional — the model this SQL is
  },
});

console.log(result.dbtContext);
// { models: 4, sources: 2, sensitiveTagged: 1, artifacts: { catalog: true, runResults: true }, warnings: [] }
```

## API

### `new SafeSQLClient(options)`

| Option    | Type            | Default                    | Notes                              |
| --------- | --------------- | -------------------------- | ---------------------------------- |
| `apiKey`  | `string`        | — (required)               | From safesqlpro.dev/settings       |
| `baseUrl` | `string`        | `https://safesqlpro.dev`   | Override the API origin            |
| `fetch`   | `FetchLike`     | `globalThis.fetch`         | Injectable — useful for tests      |

### `client.validate(params)`

| Param       | Type                                                        | Default        |
| ----------- | ----------------------------------------------------------- | -------------- |
| `sql`       | `string`                                                    | — (required)   |
| `ddl`       | `string`                                                    | `''`           |
| `dialect`   | `'postgresql' \| 'mysql' \| 'bigquery' \| 'snowflake'`      | `'postgresql'` |
| `threshold` | `number` (0–100)                                            | `70`           |
| `signal`    | `AbortSignal`                                               | —              |
| `dbt`       | `DbtArtifacts` — `{ manifest, catalog?, runResults?, sensitiveTags?, currentModel? }` | — |

Returns `Promise<ValidationResult>`:

```typescript
interface ValidationResult {
  valid: boolean;        // score >= threshold
  score: number;         // 0-100
  verdict: 'CLEAN' | 'REVIEW' | 'RISKY' | 'CRITICAL';
  issues: Issue[];       // errors first, then warnings, then suggestions
  executionTime: number; // server-side detection time, ms
  tier?: string;         // plan the API ran under; 'free' runs 12 of 35 detectors
  detectorsRun?: string[];
  upgradePrompt?: string;
  dbtContext?: DbtContextSummary; // only when `dbt` was sent — counts, never the artifacts
}

interface Issue {
  issueType: string;     // e.g. 'AGGREGATE_OVER_FANOUT_JOIN'
  severity: 'error' | 'warning' | 'suggestion';
  message: string;
  fix: string;
  scoreImpact: number;   // negative, e.g. -35
  offendingClause?: string;
  offendingColumn?: string;
  offendingTable?: string;
  lineStart?: number;
  lineEnd?: number;
}
```

### Verdict bands

| Score  | Verdict    | Meaning                                                  |
| ------ | ---------- | -------------------------------------------------------- |
| 0–40   | `CRITICAL` | Hard error — unknown column/table, cartesian, destructive |
| 41–69  | `RISKY`    | High-risk semantic warning — fan-out, LEFT JOIN in WHERE  |
| 70–84  | `REVIEW`   | Medium warning — integer division, COUNT after join       |
| 85–100 | `CLEAN`    | Suggestions only                                          |

### Errors

Non-2xx responses throw `SafeSQLError` with a `status` field:

```typescript
import { SafeSQLError } from '@safesqlpro/sdk';

try {
  await client.validate({ sql });
} catch (err) {
  if (err instanceof SafeSQLError && err.status === 429) {
    // monthly API limit hit — upgrade at safesqlpro.dev/pricing
  }
}
```

## Runtimes

Node.js 18+, browsers, and Cloudflare Workers. No runtime dependencies — only
`fetch`. In runtimes without a global `fetch`, pass your own via `options.fetch`.

## License

Apache-2.0 © Mpingo Systems LLC
