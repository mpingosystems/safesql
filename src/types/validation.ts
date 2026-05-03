export interface ValidationRequest {
  sql: string;
  schema?: SchemaDefinition;
  dialect: 'postgresql' | 'mysql' | 'bigquery' | 'snowflake' | 'ansi';
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
}

export interface SandboxResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  executionMs: number;
  expectedRows?: number;
  rowCountFlag?: {
    expected: number;
    actual: number;
    ratio: number;
    message: string;
  };
}
