// Public type surface of @safesqlpro/sdk. These mirror the Issue Object
// Contract used by the detection engine, renamed to the external names the
// REST API documents (`issueType` / `message` rather than `id` / `description`).

export type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

export type Severity = 'error' | 'warning' | 'suggestion';

/** Score bands from the SafeSQL score policy (0-100). */
export type Verdict = 'CLEAN' | 'REVIEW' | 'RISKY' | 'CRITICAL';

export interface Issue {
  /** Detector identifier, e.g. 'AGGREGATE_OVER_FANOUT_JOIN'. */
  issueType: string;
  severity: Severity;
  message: string;
  fix: string;
  /** Negative number: how much this finding subtracts from a perfect 100. */
  scoreImpact: number;
  offendingClause?: string;
  offendingColumn?: string;
  offendingTable?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ValidationResult {
  /** true when score >= the requested threshold (default 70). */
  valid: boolean;
  score: number;
  verdict: Verdict;
  issues: Issue[];
  /** Server-side detection time in milliseconds. */
  executionTime: number;
  /** Plan the API ran this validation under. Free runs a narrowed detector set. */
  tier?: string;
  /** issueType strings that were eligible to run for that tier. */
  detectorsRun?: string[];
  /** Present only when a narrowed tier withheld findings on this query. */
  upgradePrompt?: string;
  /** Present only when `dbt` artifacts were sent. */
  dbtContext?: DbtContextSummary;
}

/**
 * Parsed dbt `target/` artifacts. `manifest` is required; the rest are optional.
 * When supplied, the API derives the schema from catalog + manifest (PK/FK/
 * nullable from the project's own tests) and runs the UNAPPROVED_SOURCE and
 * FINANCE_TAG_UNVALIDATED detectors. Total request body is capped at 25 MB.
 */
export interface DbtArtifacts {
  /** Parsed target/manifest.json (dbt manifest schema v10-v12). */
  manifest: object;
  /** Parsed target/catalog.json from `dbt docs generate`. */
  catalog?: object;
  /** Parsed target/run_results.json. */
  runResults?: object;
  /** Tags that mark a relation sensitive. Default ['finance', 'pii']. */
  sensitiveTags?: string[];
  /** dbt name of the model whose SQL this is; exempts a staging model reading its own source. */
  currentModel?: string;
}

/** Provenance of the dbt context the API loaded — counts only, never the artifacts. */
export interface DbtContextSummary {
  models: number;
  sources: number;
  /** Relations carrying any configured sensitive tag. */
  sensitiveTagged: number;
  artifacts: { catalog: boolean; runResults: boolean };
  /** Non-fatal artifact problems (unknown schema version, orphan catalog node). */
  warnings: string[];
}

export interface ValidateParams {
  sql: string;
  ddl?: string;
  dialect?: Dialect;
  /** 0-100. Score below this marks the result invalid. Default 70. */
  threshold?: number;
  /** Abort the request early. */
  signal?: AbortSignal;
  /** dbt artifacts — sent as the `dbt` body field only when present. */
  dbt?: DbtArtifacts;
}

/** Minimal fetch shape, so the client works in Node, browsers and Workers. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SafeSQLClientOptions {
  /** API key from safesqlpro.dev/settings. */
  apiKey: string;
  /** Override the API origin. Default https://safesqlpro.dev */
  baseUrl?: string;
  /** Injectable fetch — defaults to globalThis.fetch. */
  fetch?: FetchLike;
}
