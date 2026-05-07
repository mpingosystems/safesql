export interface ValidationRequest {
  sql: string;
  schema?: SchemaDefinition;
  dialect: 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';
  expectedRowCount?: number;
}

export interface ValidationReport {
  riskScore: number;
  executionSafe: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  suggestions: ValidationIssue[];
  estimatedRows?: number;
  processingMs: number;
}

export interface ValidationIssue {
  id: DetectorId;
  severity: 'error' | 'warning' | 'suggestion';
  title: string;
  description: string;
  explanation?: string;
  fix?: string;
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
