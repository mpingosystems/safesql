import { Parser } from 'node-sql-parser';
import type {
  SchemaDefinition,
  ValidationIssue,
  ValidationReport,
  ValidationRequest,
} from '../types/validation';
import { unwrapName } from './schemaParser';

const parser = new Parser();

// Extract a column name from a column_ref or aggregate-arg node.
// node-sql-parser v5 wraps names as { column: { expr: { value: '...' } } }.
function getColumnName(node: any): string | null {
  if (!node) return null;
  if (node.type === 'column_ref') return unwrapName(node.column);
  if (typeof node.column !== 'undefined') return unwrapName(node.column);
  if (typeof node === 'string') return node;
  return unwrapName(node);
}

// Extract the table qualifier from a column_ref node, if present.
function getColumnTable(node: any): string | null {
  if (!node) return null;
  if (typeof node.table === 'string' && node.table.length > 0) return node.table;
  return null;
}

export function validateSQL(request: ValidationRequest): ValidationReport {
  const start = performance.now();
  const issues: ValidationIssue[] = [];

  let ast: any;
  try {
    ast = parser.astify(request.sql, { database: request.dialect });
  } catch (e) {
    return {
      riskScore: 0,
      executionSafe: false,
      errors: [
        {
          id: 'SYNTAX_ERROR',
          severity: 'error',
          title: 'SQL Syntax Error',
          description: `Cannot parse SQL: ${(e as Error).message}`,
        },
      ],
      warnings: [],
      suggestions: [],
      processingMs: performance.now() - start,
    };
  }

  issues.push(...detectMissingWhereDestructive(ast));
  issues.push(...detectIncompleteGroupBy(ast));
  issues.push(...detectContradictoryFilter(ast));
  issues.push(...detectJoinMultiplication(ast, request.schema));
  issues.push(...detectSelectStar(ast, request.schema));
  issues.push(...detectInnerJoinNullExclusion(ast, request.schema));
  issues.push(...detectAggregationGrainMismatch(ast, request.schema));

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const suggestions = issues.filter((i) => i.severity === 'suggestion');

  return {
    riskScore: calculateRiskScore(errors.length, warnings.length),
    executionSafe: errors.length === 0,
    errors,
    warnings,
    suggestions,
    processingMs: performance.now() - start,
  };
}

function calculateRiskScore(errorCount: number, warningCount: number): number {
  if (errorCount > 0) return Math.max(0, 40 - errorCount * 15);
  if (warningCount > 0) return Math.max(41, 85 - warningCount * 10);
  return 100;
}

function asStatements(ast: any): any[] {
  return Array.isArray(ast) ? ast : [ast];
}

const AGG_FUNCS = new Set(['sum', 'count', 'avg', 'min', 'max', 'count_distinct']);

function isAggregateExpr(expr: any): boolean {
  if (!expr) return false;
  if (expr.type === 'aggr_func') return true;
  if (expr.name && typeof expr.name === 'string' && AGG_FUNCS.has(expr.name.toLowerCase())) {
    return true;
  }
  return false;
}

function hasAggregateFunction(columns: any[]): boolean {
  if (!columns) return false;
  return columns.some((col) => isAggregateExpr(col.expr ?? col));
}

// ── D2: Missing WHERE on destructive operations (no schema needed) ──────────
function detectMissingWhereDestructive(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if ((stmt?.type === 'update' || stmt?.type === 'delete') && !stmt.where) {
      const op = stmt.type.toUpperCase();
      issues.push({
        id: 'MISSING_WHERE_DESTRUCTIVE',
        severity: 'error',
        title: `${op} without WHERE clause`,
        description: `This ${op} statement has no WHERE clause and will affect every row in the table.`,
        fix: `Add a WHERE clause to limit scope: ${op} ... WHERE id = ?`,
      });
    }
  }
  return issues;
}

// ── D3: Incomplete GROUP BY (no schema needed) ──────────────────────────────
function detectIncompleteGroupBy(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;
    if (!stmt.columns || stmt.columns.length === 0) continue;

    const hasAgg = stmt.columns.some((col: any) => isAggregateExpr(col.expr));
    if (!hasAgg) continue;

    const nonAggCols: string[] = stmt.columns
      .filter((col: any) => !isAggregateExpr(col.expr) && col.expr?.type !== 'star')
      .map((col: any) => getColumnName(col.expr) ?? col.as)
      .filter(Boolean);

    const groupByItems: any[] = stmt.groupby?.columns ?? stmt.groupby ?? [];
    const groupByCols: string[] = groupByItems
      .map((g: any) => getColumnName(g))
      .filter((s: string | null): s is string => typeof s === 'string');

    const missing = nonAggCols.filter((c) => !groupByCols.includes(c));

    if (missing.length > 0) {
      issues.push({
        id: 'INCOMPLETE_GROUP_BY',
        severity: 'error',
        title: 'Non-aggregated columns not in GROUP BY',
        description: `Column(s) [${missing.join(', ')}] appear in SELECT but not in GROUP BY. This is invalid SQL in strict mode.`,
        fix: `Add to GROUP BY: GROUP BY ${[...groupByCols, ...missing].join(', ')}`,
      });
    }
  }
  return issues;
}

// ── D4: Contradictory filter (no schema needed) ─────────────────────────────
function detectContradictoryFilter(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (!stmt?.where) continue;

    const conditions = new Map<string, Set<string>>();
    extractAndEqualityConditions(stmt.where, conditions);

    for (const [column, values] of conditions.entries()) {
      if (values.size > 1) {
        const valList = Array.from(values).join(', ');
        const [v1, v2] = Array.from(values);
        issues.push({
          id: 'CONTRADICTORY_FILTER',
          severity: 'error',
          title: 'Contradictory WHERE condition',
          description: `Column "${column}" is filtered to multiple mutually exclusive values: [${valList}]. This will always return 0 rows.`,
          fix: `Use OR instead of AND: WHERE ${column} = '${v1}' OR ${column} = '${v2}'`,
          metadata: { column, values: Array.from(values) },
        });
      }
    }
  }
  return issues;
}

// Walk WHERE tree, collecting equality predicates joined exclusively by AND.
// We intentionally do NOT descend into OR branches — those don't create
// contradictions of the form (col = a AND col = b).
function extractAndEqualityConditions(node: any, out: Map<string, Set<string>>): void {
  if (!node) return;

  if (node.type === 'binary_expr') {
    const op = String(node.operator ?? '').toUpperCase();
    if (op === 'AND') {
      extractAndEqualityConditions(node.left, out);
      extractAndEqualityConditions(node.right, out);
      return;
    }
    if (op === '=') {
      const colNode =
        node.left?.type === 'column_ref'
          ? node.left
          : node.right?.type === 'column_ref'
            ? node.right
            : null;
      const valNode = colNode === node.left ? node.right : colNode === node.right ? node.left : null;
      const col = getColumnName(colNode);
      const val = valNode?.value;
      if (col && val !== undefined && val !== null) {
        if (!out.has(col)) out.set(col, new Set());
        out.get(col)!.add(String(val));
      }
      return;
    }
    // Any other operator (OR, IN, BETWEEN, !=, etc.) — stop descent.
  }
}

// ── D1: JOIN multiplication (schema optional) ───────────────────────────────
function detectJoinMultiplication(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;
    if (!stmt.from || stmt.from.length < 2) continue;

    const joins = stmt.from.filter((f: any) => f.join);
    const hasAggregate = hasAggregateFunction(stmt.columns);
    const hasGroupBy = !!(stmt.groupby && (stmt.groupby.columns ?? stmt.groupby).length > 0);
    const hasDistinct = stmt.distinct === 'DISTINCT';

    for (const join of joins) {
      const joinTable = join.table || join.as;
      const isOneToMany = schema ? isOneToManyRelationship(joinTable, schema) : true;

      if (isOneToMany && !hasAggregate && !hasGroupBy && !hasDistinct) {
        issues.push({
          id: 'JOIN_MULTIPLICATION',
          severity: 'warning',
          title: 'JOIN may multiply rows',
          description: `JOIN with "${joinTable}" may return multiple rows per parent record. Without GROUP BY or aggregation, row counts will be inflated.`,
          fix:
            `Pick one: (a) pre-aggregate "${joinTable}" in a CTE before joining, ` +
            `(b) add GROUP BY on the parent table's primary key, ` +
            `(c) wrap with SELECT DISTINCT — and verify the join key is unique on "${joinTable}".`,
          metadata: { joinTable },
        });
      }
    }
  }
  return issues;
}

function isOneToManyRelationship(joinTableName: string | undefined, schema: SchemaDefinition): boolean {
  if (!joinTableName) return true;
  const t = schema.tables.find((x) => x.name === joinTableName);
  if (!t) return true;
  return t.columns.some((c) => c.isFK);
}

// ── D5: SELECT * on expensive tables (schema optional) ──────────────────────
const COLUMNAR_HINTS = ['transactions', 'events', 'logs', 'audit', 'pageviews', 'clicks'];

function detectSelectStar(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const hasStar = stmt.columns?.some(
      (col: any) => col.expr?.type === 'star' || col.expr?.column === '*',
    );
    if (!hasStar) continue;

    const tables: string[] = (stmt.from || []).map((f: any) => f.table).filter(Boolean);

    for (const tableName of tables) {
      const schemaTable = schema?.tables.find((t) => t.name === tableName);
      const isLarge = !!(schemaTable?.estimatedRows && schemaTable.estimatedRows > 1_000_000);
      const lower = tableName.toLowerCase();
      const isColumnar = COLUMNAR_HINTS.some((name) => lower.includes(name));

      if (isLarge || isColumnar) {
        issues.push({
          id: 'SELECT_STAR_EXPENSIVE',
          severity: 'warning',
          title: `SELECT * on potentially large table "${tableName}"`,
          description: `SELECT * scans all columns. On large tables this causes high I/O and cost on columnar stores (BigQuery, Snowflake, Redshift).`,
          fix: `Specify only needed columns: SELECT id, name, status FROM ${tableName}`,
          metadata: { tableName },
        });
      } else {
        issues.push({
          id: 'SELECT_STAR_EXPENSIVE',
          severity: 'suggestion',
          title: `SELECT * on "${tableName}"`,
          description: `SELECT * retrieves all columns including those you may not need.`,
          fix: `Consider specifying columns explicitly for better performance and clarity.`,
          metadata: { tableName },
        });
      }
    }
  }
  return issues;
}

// ── D6: INNER JOIN on nullable FK (schema required) ─────────────────────────
function detectInnerJoinNullExclusion(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const innerJoins = (stmt.from || []).filter(
      (f: any) => f.join === 'INNER JOIN' || f.join === 'JOIN',
    );

    // Build alias → real-table-name lookup from FROM list
    const aliasMap = new Map<string, string>();
    for (const f of stmt.from || []) {
      if (f.table) {
        if (f.as) aliasMap.set(f.as, f.table);
        aliasMap.set(f.table, f.table);
      }
    }

    for (const join of innerJoins) {
      const onCond = join.on;
      if (!onCond) continue;

      const candidates = [onCond.left, onCond.right].filter(Boolean);
      for (const node of candidates) {
        const col = getColumnName(node);
        const tblQualifier = getColumnTable(node);
        const realTable = tblQualifier ? aliasMap.get(tblQualifier) ?? tblQualifier : join.table;
        if (!col || !realTable) continue;

        const schemaTable = schema.tables.find((t) => t.name === realTable);
        const schemaCol = schemaTable?.columns.find((c) => c.name === col);

        if (schemaCol?.nullable && schemaCol?.isFK) {
          issues.push({
            id: 'INNER_JOIN_NULL_EXCLUSION',
            severity: 'warning',
            title: `INNER JOIN on nullable column "${col}"`,
            description: `Column "${realTable}.${col}" is nullable. INNER JOIN silently drops rows where "${col}" is NULL, which may exclude data you want to include.`,
            fix: `Use LEFT JOIN if you want to keep rows without a match: LEFT JOIN ${realTable} ON ...`,
            metadata: { table: realTable, column: col },
          });
          break; // one finding per join is enough
        }
      }
    }
  }
  return issues;
}

// ── D7: Aggregation grain mismatch (schema required) ────────────────────────
function detectAggregationGrainMismatch(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const aggColumns = (stmt.columns || []).filter((col: any) => isAggregateExpr(col.expr));
    if (aggColumns.length === 0) continue;

    const hasGroupBy = !!(stmt.groupby && (stmt.groupby.columns ?? stmt.groupby).length > 0);
    const joins = (stmt.from || []).filter((f: any) => f.join);

    if (joins.length > 0 && !hasGroupBy) {
      const aggNames = aggColumns
        .map((c: any) => {
          const name = c.expr?.name ?? 'AGG';
          const arg = getColumnName(c.expr?.args?.expr) ?? '*';
          return `${name}(${arg})`;
        })
        .join(', ');

      issues.push({
        id: 'AGGREGATION_GRAIN_MISMATCH',
        severity: 'warning',
        title: 'Aggregation across a JOIN without GROUP BY',
        description: `${aggNames} aggregates across a JOIN result. Without GROUP BY, this aggregates ALL rows including duplicates from the JOIN. Result may be inflated.`,
        fix: `Add GROUP BY on the primary key of your root table to control aggregation grain.`,
      });
    }
  }
  return issues;
}
