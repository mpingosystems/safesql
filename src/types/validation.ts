export type SqlSource = 'cursor' | 'copilot' | 'chatgpt' | 'manual' | 'unknown';

export interface ValidationRequest {
  sql: string;
  schema?: SchemaDefinition;
  dialect: 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';
  expectedRowCount?: number;
  // PQ1 — LLM source tagging. Where the SQL came from, so AI-generated query
  // quality can be tracked separately from human-authored SQL.
  source?: SqlSource;
}

export interface ValidationReport {
  riskScore: number;
  executionSafe: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  suggestions: ValidationIssue[];
  estimatedRows?: number;
  processingMs: number;
  // PQ1 — carried through from the request so the source badge displays and the
  // tag persists inside the stored report JSON (no extra DB column required).
  source?: SqlSource;
}

export interface ValidationIssue {
  // `id` is the canonical detector identifier. It doubles as the Issue Object
  // Contract's `issueType` field (Sprint 3 §10) — same string, two names kept
  // so existing tests/UI that read `id` and external consumers that expect
  // `issueType` both work.
  id: DetectorId;
  severity: 'error' | 'warning' | 'suggestion';
  title: string;
  description: string;
  explanation?: string;
  fix?: string;
  // ── Issue Object Contract (Sprint 3 §10) ──────────────────────────────────
  // The clause / table / column the finding points at, where applicable. Used
  // both for human messaging and to anchor Monaco inline markers (PQ3).
  offendingClause?: 'SELECT' | 'FROM' | 'JOIN' | 'WHERE' | 'GROUP BY' | 'HAVING' | 'ORDER BY';
  offendingTable?: string;
  offendingColumn?: string;
  // Negative number: how much this finding subtracts from a perfect 100.
  scoreImpact?: number;
  lineStart?: number;
  lineEnd?: number;
  columnStart?: number;
  columnEnd?: number;
  metadata?: Record<string, unknown>;
}

export type DetectorId =
  | 'MISSING_WHERE_DESTRUCTIVE'
  | 'INCOMPLETE_GROUP_BY'
  | 'CONTRADICTORY_FILTER'
  | 'JOIN_MULTIPLICATION'
  | 'SELECT_STAR_EXPENSIVE'
  | 'INNER_JOIN_NULL_EXCLUSION'
  | 'AGGREGATION_GRAIN_MISMATCH'
  | 'HALLUCINATED_TABLE'
  | 'HALLUCINATED_COLUMN'
  | 'NULL_EQUALITY_COMPARISON'
  | 'NOT_IN_NULLABLE'
  | 'AVG_OVER_NULLABLE'
  // ── Sprint 3 additions ────────────────────────────────────────────────────
  | 'UNKNOWN_ALIAS'
  | 'AMBIGUOUS_COLUMN'
  | 'LEFT_JOIN_FILTERED_IN_WHERE'
  | 'SUSPICIOUS_JOIN_KEY'
  | 'CARTESIAN_JOIN'
  | 'CROSS_JOIN_RISK'
  | 'AGGREGATE_OVER_FANOUT_JOIN'
  | 'MULTIPLE_ONE_TO_MANY_JOINS'
  | 'SCD_JOIN_WITHOUT_EFFECTIVE_DATE'
  | 'INTEGER_DIVISION_RISK'
  | 'COUNT_PARENT_AFTER_CHILD_JOIN'
  | 'MISSING_TIME_FILTER'
  | 'DIALECT_MISMATCH'
  | 'NON_DETERMINISTIC_WINDOW_ORDER'
  | 'DESTRUCTIVE_DDL'
  | 'DESTRUCTIVE_TRUNCATE'
  | 'SYNTAX_ERROR';

export interface SchemaDefinition {
  tables: SchemaTable[];
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  estimatedRows?: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPK: boolean;
  isFK: boolean;
  fkReferencesTable?: string;
  fkReferencesColumn?: string;
  // Allowed-value list extracted from `CHECK (col IN ('a','b','c'))`.
  // Used by the sandbox to generate CHECK-constraint-respecting synthetic data.
  checkAllowedValues?: string[];
}

export interface SandboxResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  executionMs: number;
  expectedRows?: number;
  // Set if the database refused to execute the SQL — surfaces real Postgres
  // semantic errors (e.g., column not in GROUP BY) that the static rules miss.
  executionError?: string;
  rowCountFlag?: {
    expected: number;
    actual: number;
    ratio: number;
    message: string;
  };
}
