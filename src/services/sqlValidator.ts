import { Parser } from 'node-sql-parser';
import type {
  DetectorId,
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
    // A parse failure is often caused by a foreign-dialect construct that the
    // selected dialect can't parse (MySQL `LIMIT a,b`, SQL Server `TOP n`). If
    // we recognise one, surface THAT as the explanation (a 41-69 dialect
    // warning) rather than an opaque syntax error scored 0.
    const dialectIssues = detectDialectLimitTop(request.sql, request.dialect);
    if (dialectIssues.length > 0) {
      for (const issue of dialectIssues) normalizeIssueContract(issue);
      return {
        riskScore: calculateRiskScore(dialectIssues),
        executionSafe: dialectIssues.every((i) => i.severity !== 'error'),
        errors: dialectIssues.filter((i) => i.severity === 'error'),
        warnings: dialectIssues.filter((i) => i.severity === 'warning'),
        suggestions: dialectIssues.filter((i) => i.severity === 'suggestion'),
        processingMs: performance.now() - start,
        source: request.source,
      };
    }
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
      source: request.source,
    };
  }

  // ── D1–D12 (Sprint 1-2) ────────────────────────────────────────────────────
  issues.push(...detectMissingWhereDestructive(ast));
  issues.push(...detectIncompleteGroupBy(ast));
  issues.push(...detectContradictoryFilter(ast));
  issues.push(...detectJoinMultiplication(ast, request.schema));
  issues.push(...detectSelectStar(ast, request.schema));
  issues.push(...detectInnerJoinNullExclusion(ast, request.schema));
  issues.push(...detectAggregationGrainMismatch(ast, request.schema));
  issues.push(...detectHallucinatedTable(ast, request.schema));
  issues.push(...detectHallucinatedColumn(ast, request.schema));
  issues.push(...detectNullEqualityComparison(ast));
  issues.push(...detectNotInNullable(ast, request.schema));
  issues.push(...detectAvgOverNullable(ast, request.schema));

  // ── Sprint 3 additions ──────────────────────────────────────────────────────
  issues.push(...detectDestructiveDDL(ast));
  issues.push(...detectUnknownAlias(ast));
  issues.push(...detectAmbiguousColumn(ast, request.schema));
  issues.push(...detectCartesianAndCrossJoin(ast));
  issues.push(...detectLeftJoinFilteredInWhere(ast));
  issues.push(...detectSuspiciousJoinKey(ast, request.schema));
  issues.push(...detectFanOutJoins(ast));
  issues.push(...detectScdJoinWithoutEffectiveDate(ast));
  issues.push(...detectIntegerDivision(ast, request.schema));
  issues.push(...detectCountParentAfterChildJoin(ast));
  issues.push(...detectCountStarVsCountCol(ast, request.schema));
  issues.push(...detectHavingWithoutGroupBy(ast));
  issues.push(...detectMissingTimeFilter(ast, request.schema));
  issues.push(...detectDialectMismatch(request.sql, request.dialect));
  issues.push(...detectNonDeterministicWindow(ast));

  // ── Sprint 3b additions ─────────────────────────────────────────────────────
  issues.push(...detectCoalesceInJoinKey(ast));
  issues.push(...detectWindowMissingOrder(ast));
  issues.push(...detectMissingTimeFilterBareScan(ast));
  issues.push(...detectImplicitTimezone(ast));
  issues.push(...detectDialectLimitTop(request.sql, request.dialect));

  // Issue Object Contract (§10): make sure every finding carries the offending
  // anchor fields + a scoreImpact, deriving them from legacy `metadata`/severity
  // when a detector didn't set them explicitly.
  for (const issue of issues) normalizeIssueContract(issue);

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const suggestions = issues.filter((i) => i.severity === 'suggestion');

  return {
    riskScore: calculateRiskScore(issues),
    executionSafe: errors.length === 0,
    errors,
    warnings,
    suggestions,
    processingMs: performance.now() - start,
    source: request.source,
  };
}

// High-risk warnings land in the 41-69 band; everything else warning-level is a
// "medium" warning in the 70-84 band. This is the §11 Score Policy made concrete.
//
// Sprint 3b decision: AGGREGATE_OVER_FANOUT_JOIN (and NOT_IN_NULLABLE) stay
// WARNINGS in the 41-69 band. The Sprint 3 prompt's §3 prose called fan-out an
// "error <50", but the SAME prompt's §11 score-policy table classifies fan-out
// as a high-risk *warning* (41-69) — and that policy is the one that shipped and
// is tested. The table wins; fan-out remains a high-risk warning (scores ~60).
const HIGH_RISK_WARNINGS = new Set<DetectorId>([
  'LEFT_JOIN_FILTERED_IN_WHERE',
  'SUSPICIOUS_JOIN_KEY',
  'CROSS_JOIN_RISK',
  'AGGREGATE_OVER_FANOUT_JOIN',
  'MULTIPLE_ONE_TO_MANY_JOINS',
  'SCD_JOIN_WITHOUT_EFFECTIVE_DATE',
  'MISSING_TIME_FILTER',
  'DIALECT_MISMATCH',
  'AMBIGUOUS_COLUMN',
  // Sprint 3b additions:
  'COALESCE_IN_JOIN_KEY',
  'WINDOW_MISSING_ORDER',
]);

// §11 Score Policy. Tier of the WORST finding sets the band; additional findings
// of that tier nudge the score down within the band. Fixed queries (fewer/less
// severe findings) always score strictly higher than their flawed originals.
function calculateRiskScore(issues: ValidationIssue[]): number {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) return Math.max(0, 40 - errors.length * 15); // 0-40 band

  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length > 0) {
    const highRisk = warnings.filter((w) => HIGH_RISK_WARNINGS.has(w.id));
    if (highRisk.length > 0) {
      return Math.max(41, 60 - (highRisk.length - 1) * 6); // 41-69 band
    }
    return Math.max(70, 80 - (warnings.length - 1) * 4); // 70-84 band
  }

  const suggestions = issues.filter((i) => i.severity === 'suggestion');
  // Suggestions stay in the Safe band but visibly nudge the score so users
  // notice them rather than seeing an unchanged 100.
  if (suggestions.length > 0) return Math.max(85, 100 - suggestions.length * 5);
  return 100;
}

// Default per-tier scoreImpact for the contract. Detectors may override by
// setting `issue.scoreImpact` directly; this only fills the gaps.
const DEFAULT_SCORE_IMPACT: Record<ValidationIssue['severity'], number> = {
  error: -75,
  warning: -25,
  suggestion: -5,
};

function normalizeIssueContract(issue: ValidationIssue): void {
  const meta = (issue.metadata ?? {}) as Record<string, unknown>;
  if (issue.offendingTable === undefined) {
    const t = meta.table ?? meta.tableName ?? meta.joinTable ?? meta.sourceTable;
    if (typeof t === 'string') issue.offendingTable = t;
  }
  if (issue.offendingColumn === undefined) {
    const c = meta.column ?? meta.sourceColumn;
    if (typeof c === 'string') issue.offendingColumn = c;
  }
  if (issue.scoreImpact === undefined) {
    // High-risk warnings bite harder than medium ones, matching the bands.
    if (issue.severity === 'warning' && HIGH_RISK_WARNINGS.has(issue.id)) {
      issue.scoreImpact = -40;
    } else {
      issue.scoreImpact = DEFAULT_SCORE_IMPACT[issue.severity];
    }
  }
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

// Per-statement: collect CTE names + subquery aliases that should NOT be
// flagged as hallucinated tables (they're locally defined, not in the schema).
// node-sql-parser puts CTEs at stmt.with[].name.value and subquery FROM
// entries at f.expr.ast (with f.as as alias).
function collectLocalTableNames(stmt: any): Set<string> {
  const local = new Set<string>();
  if (!stmt) return local;
  if (Array.isArray(stmt.with)) {
    for (const cte of stmt.with) {
      const name = unwrapCteName(cte);
      if (name) local.add(name);
    }
  }
  if (Array.isArray(stmt.from)) {
    for (const f of stmt.from) {
      if (f?.expr?.ast && typeof f.as === 'string' && f.as) local.add(f.as);
    }
  }
  return local;
}

function unwrapCteName(cte: any): string | null {
  if (!cte) return null;
  const n = cte.name;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && typeof n.value === 'string') return n.value;
  return null;
}

// ── D8: Hallucinated table (schema required) ────────────────────────────────
// Walks every table reference in FROM / JOIN / UPDATE / DELETE and flags any
// name not present in the schema (and not locally defined as a CTE / subquery
// alias). Critical for AI-SQL validation.
function detectHallucinatedTable(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const known = new Set(schema.tables.map((t) => t.name));

  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;
    const local = collectLocalTableNames(stmt);
    const seen = new Set<string>(); // dedupe per statement

    const flag = (name: string) => {
      if (!name || seen.has(name) || known.has(name) || local.has(name)) return;
      seen.add(name);
      const closest = nearestName(name, [...known]);
      issues.push({
        id: 'HALLUCINATED_TABLE',
        severity: 'error',
        title: `Table "${name}" not found in schema`,
        description:
          `The query references table "${name}", but the parsed schema has no such table. ` +
          `This will fail at execution. Common cause: AI-generated SQL that hallucinated a plausible-sounding name.`,
        fix: closest
          ? `Did you mean "${closest}"? Available tables: ${[...known].join(', ')}.`
          : `Available tables in schema: ${[...known].join(', ') || '(none)'}.`,
        metadata: { table: name, suggestion: closest ?? null },
      });
    };

    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) {
        if (f && typeof f.table === 'string') flag(f.table);
      }
    }
    if (stmt.type === 'update' || stmt.type === 'delete') {
      const tables: any[] = Array.isArray(stmt.table) ? stmt.table : stmt.table ? [stmt.table] : [];
      for (const t of tables) {
        const name = typeof t === 'string' ? t : t?.table;
        if (typeof name === 'string') flag(name);
      }
    }
  }

  return issues;
}

// ── D9: Hallucinated column (schema required) ──────────────────────────────
// Resolves two cases:
//   1. Qualified refs (`alias.col` / `table.col`) — fully supported.
//   2. Bare unqualified refs — only when SELECT has exactly ONE schema table
//      in FROM and no CTEs declared. Multi-table joins, CTE scope, and
//      subqueries-in-FROM stay deferred to v2 (those need a real resolver).
function detectHallucinatedColumn(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;
    const local = collectLocalTableNames(stmt);
    const seen = new Set<string>(); // dedupe per statement by `table.column`

    // Build alias → real-table-name lookup from the FROM list.
    const aliasMap = new Map<string, string>();
    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) {
        if (f && typeof f.table === 'string') {
          aliasMap.set(f.table, f.table);
          if (typeof f.as === 'string' && f.as) aliasMap.set(f.as, f.table);
        }
      }
    }

    // Single-table FROM resolution context (else null = bare cols deferred).
    let singleFromTable: SchemaDefinition['tables'][number] | null = null;
    if (
      stmt.type === 'select' &&
      Array.isArray(stmt.from) &&
      stmt.from.length === 1 &&
      !Array.isArray(stmt.with)
    ) {
      const f = stmt.from[0];
      // Plain table ref only — exclude FROM subqueries (f.expr.ast).
      if (f && typeof f.table === 'string' && !f.expr) {
        singleFromTable = tableByName.get(f.table) ?? null;
      }
    }

    // SELECT-clause output aliases — ORDER BY can legally reference these,
    // so don't flag them as hallucinated bare columns.
    const selectAliases = new Set<string>();
    if (Array.isArray(stmt.columns)) {
      for (const c of stmt.columns) {
        if (typeof c?.as === 'string' && c.as) selectAliases.add(c.as);
      }
    }

    const visit = (colNode: any) => {
      const tableQual = getColumnTable(colNode);
      const colName = getColumnName(colNode);
      if (!colName || colName === '*') return;

      if (!tableQual) {
        // Bare column — only resolve when single-table FROM context is set.
        if (!singleFromTable) return;
        if (selectAliases.has(colName)) return;
        if (singleFromTable.columns.some((c) => c.name === colName)) return;
        const key = `${singleFromTable.name}.${colName}`;
        if (seen.has(key)) return;
        seen.add(key);
        const colNames = singleFromTable.columns.map((c) => c.name);
        const closest = nearestName(colName, colNames);
        issues.push({
          id: 'HALLUCINATED_COLUMN',
          severity: 'error',
          title: `Column "${colName}" not found on table "${singleFromTable.name}"`,
          description:
            `The query references "${colName}", but that column does not exist on "${singleFromTable.name}". ` +
            `This will fail at execution. Common cause: AI-generated SQL hallucinating a plausible column name.`,
          fix: closest
            ? `Did you mean "${closest}"? Columns on "${singleFromTable.name}": ${colNames.join(', ')}.`
            : `Columns on "${singleFromTable.name}": ${colNames.join(', ') || '(none)'}.`,
          metadata: { table: singleFromTable.name, column: colName, suggestion: closest ?? null },
        });
        return;
      }

      // Skip locally-defined names (CTE / subquery alias) — out of D9's scope.
      if (local.has(tableQual)) return;
      const realTable = aliasMap.get(tableQual) ?? tableQual;
      if (local.has(realTable)) return;
      const schemaTable = tableByName.get(realTable);
      // If the table itself is unknown, that's D8's job, not D9's.
      if (!schemaTable) return;
      const exists = schemaTable.columns.some((c) => c.name === colName);
      if (exists) return;
      const key = `${realTable}.${colName}`;
      if (seen.has(key)) return;
      seen.add(key);
      const colNames = schemaTable.columns.map((c) => c.name);
      const closest = nearestName(colName, colNames);
      issues.push({
        id: 'HALLUCINATED_COLUMN',
        severity: 'error',
        title: `Column "${colName}" not found on table "${realTable}"`,
        description:
          `The query references "${realTable}.${colName}", but that column does not exist in the schema. ` +
          `This will fail at execution. Common cause: AI-generated SQL hallucinating a plausible column name.`,
        fix: closest
          ? `Did you mean "${realTable}.${closest}"? Columns on "${realTable}": ${colNames.join(', ')}.`
          : `Columns on "${realTable}": ${colNames.join(', ') || '(none)'}.`,
        metadata: { table: realTable, column: colName, suggestion: closest ?? null },
      });
    };

    // Walk the statement's *child* properties — not `stmt` itself, which
    // would short-circuit on the top-level `select` skip-rule.
    walkColumnRefs(stmt.columns, visit);
    walkColumnRefs(stmt.where, visit);
    walkColumnRefs(stmt.from, visit); // covers JOIN ON conditions
    walkColumnRefs(stmt.groupby, visit);
    walkColumnRefs(stmt.orderby, visit);
    walkColumnRefs(stmt.having, visit);
  }

  return issues;
}

// Recurse through any AST sub-tree, calling `visit` on every column_ref.
// Stops at nested SELECTs (subqueries / CTEs) — they have their own scope
// and need their own resolution pass, deferred for v2.
function walkColumnRefs(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'column_ref') {
    visit(node);
    return;
  }
  if (node.type === 'select') return; // do not recurse into nested SELECTs
  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (Array.isArray(v)) {
      for (const item of v) walkColumnRefs(item, visit);
    } else if (v && typeof v === 'object') {
      walkColumnRefs(v, visit);
    }
  }
}

// Cheap "did you mean?" — Levenshtein on small candidate sets is fine here.
// Returns null if nothing is within distance 3 (avoids absurd suggestions).
function nearestName(needle: string, hay: string[]): string | null {
  if (!needle || hay.length === 0) return null;
  let best: { name: string; d: number } | null = null;
  for (const candidate of hay) {
    const d = levenshtein(needle.toLowerCase(), candidate.toLowerCase());
    if (best === null || d < best.d) best = { name: candidate, d };
  }
  if (!best) return null;
  // Cap suggestion at distance 3 OR ≤ 40% of the longer string, whichever larger.
  const maxLen = Math.max(needle.length, best.name.length);
  const threshold = Math.max(3, Math.ceil(maxLen * 0.4));
  return best.d <= threshold ? best.name : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// node-sql-parser v5 represents NULL literals as { type: 'null', value: null }.
function isNullLiteral(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  return node.type === 'null';
}

// Walk WHERE / HAVING / ON looking for nodes matching `predicate`. Stops at
// nested SELECTs and BOOL/AND/OR shortcuts work transparently because we
// recurse through left/right.
function walkPredicates(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'select') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (Array.isArray(v)) {
      for (const item of v) walkPredicates(item, visit);
    } else if (v && typeof v === 'object') {
      walkPredicates(v, visit);
    }
  }
}

// ── D10: NULL equality comparison (no schema needed) ────────────────────────
// Flags `col = NULL`, `col != NULL`, `col <> NULL` anywhere in WHERE / HAVING
// / JOIN ON. Per ANSI SQL these always evaluate to UNKNOWN, never TRUE — so
// the predicate silently filters out every row. Pure logic bug.
function detectNullEqualityComparison(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>(); // dedupe by column name

  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;
    const visit = (node: any) => {
      if (node?.type !== 'binary_expr') return;
      const op = String(node.operator ?? '').toUpperCase();
      if (op !== '=' && op !== '!=' && op !== '<>') return;
      const nullSide = isNullLiteral(node.left)
        ? 'left'
        : isNullLiteral(node.right)
          ? 'right'
          : null;
      if (!nullSide) return;
      const colNode = nullSide === 'left' ? node.right : node.left;
      const col = getColumnName(colNode) ?? '<expr>';
      const key = `${op}::${col}`;
      if (seen.has(key)) return;
      seen.add(key);
      const replacement = op === '=' ? 'IS NULL' : 'IS NOT NULL';
      issues.push({
        id: 'NULL_EQUALITY_COMPARISON',
        severity: 'error',
        title: `Comparison "${col} ${op} NULL" never matches any row`,
        description:
          `Per ANSI SQL, comparing a value to NULL with "${op}" always evaluates to UNKNOWN, never TRUE. ` +
          `This predicate silently excludes every row, which is almost never the intended behavior.`,
        fix: `Use ${replacement}: WHERE ${col} ${replacement}`,
        metadata: { column: col, operator: op },
      });
    };
    walkPredicates(stmt.where, visit);
    walkPredicates(stmt.having, visit);
    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) walkPredicates(f?.on, visit);
    }
  }
  return issues;
}

// ── D11: NOT IN with possible NULL values (schema optional) ─────────────────
// Two cases:
//   (a) `col NOT IN (1, 2, NULL)` — deterministic from the AST alone.
//   (b) `col NOT IN (SELECT x FROM t)` where t.x is nullable per schema.
// Both forms cause `NOT IN` to evaluate to UNKNOWN for every row, returning
// an empty result set silently.
function detectNotInNullable(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  if (schema) for (const t of schema.tables) tableByName.set(t.name, t);
  const seen = new Set<string>();

  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;

    const visit = (node: any) => {
      if (node?.type !== 'binary_expr') return;
      const op = String(node.operator ?? '').toUpperCase();
      if (op !== 'NOT IN') return;

      const lhsCol = getColumnName(node.left) ?? '<expr>';
      const rhs = node.right;

      // node-sql-parser shapes:
      //   literal list      → rhs = { type: 'expr_list', value: [{type:'string',...}, {type:'null',...}] }
      //   subquery in NOT IN → rhs = { type: 'expr_list', value: [{ ast: { type:'select', ...} }] }
      // Differentiate by inspecting the first element.
      if (rhs?.type !== 'expr_list' || !Array.isArray(rhs.value) || rhs.value.length === 0) return;
      const firstVal = rhs.value[0];
      const subqueryAst = firstVal && typeof firstVal === 'object' ? firstVal.ast : null;

      // Case (b): subquery whose selected column is nullable per schema.
      if (subqueryAst && subqueryAst.type === 'select' && schema) {
        const ss = subqueryAst;
        const cols = Array.isArray(ss.columns) ? ss.columns : [];
        if (cols.length !== 1) return;
        const expr = cols[0]?.expr;
        if (!expr || expr.type !== 'column_ref') return;
        const colName = getColumnName(expr);
        const fromList = Array.isArray(ss.from) ? ss.from : [];
        if (fromList.length !== 1) return;
        const srcTable = fromList[0]?.table;
        if (!colName || typeof srcTable !== 'string') return;
        const t = tableByName.get(srcTable);
        if (!t) return;
        const c = t.columns.find((cc) => cc.name === colName);
        if (!c?.nullable) return;
        const key = `sub::${lhsCol}::${srcTable}.${colName}`;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push({
          id: 'NOT_IN_NULLABLE',
          severity: 'warning',
          title: `NOT IN subquery may yield NULL — risk of silent empty result`,
          description:
            `"${lhsCol} NOT IN (SELECT ${colName} FROM ${srcTable})" reads from a nullable column. ` +
            `If any returned value is NULL, NOT IN evaluates to UNKNOWN for every outer row and the result is silently empty.`,
          fix:
            `Use NOT EXISTS or filter NULLs in the subquery: ` +
            `WHERE ${lhsCol} NOT IN (SELECT ${colName} FROM ${srcTable} WHERE ${colName} IS NOT NULL)`,
          metadata: { column: lhsCol, sourceTable: srcTable, sourceColumn: colName },
        });
        return;
      }

      // Case (a): explicit NULL in the literal list.
      const hasNull = rhs.value.some((v: any) => isNullLiteral(v));
      if (hasNull) {
        const key = `list::${lhsCol}`;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push({
          id: 'NOT_IN_NULLABLE',
          severity: 'warning',
          title: `NOT IN list contains NULL — query will return zero rows`,
          description:
            `"${lhsCol} NOT IN (..., NULL)" evaluates to UNKNOWN for every row because of the NULL literal in the list, ` +
            `so the result set is silently empty.`,
          fix: `Remove NULL from the list, or use "${lhsCol} IS NOT NULL AND ${lhsCol} NOT IN (...)" / NOT EXISTS instead.`,
          metadata: { column: lhsCol, source: 'literal_list' },
        });
        return;
      }
    };

    walkPredicates(stmt.where, visit);
    walkPredicates(stmt.having, visit);
    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) walkPredicates(f?.on, visit);
    }
  }
  return issues;
}

// ── D12: AVG over a nullable column (schema required) ───────────────────────
// AVG silently excludes NULLs from its denominator. Analysts who expected
// "average over all rows" get a different number than "sum / count(*)".
// Suggestion-severity: not always wrong, but worth surfacing.
function detectAvgOverNullable(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  for (const t of schema.tables) tableByName.set(t.name, t);
  const seen = new Set<string>();

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const aliasMap = new Map<string, string>();
    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) {
        if (f && typeof f.table === 'string') {
          aliasMap.set(f.table, f.table);
          if (typeof f.as === 'string' && f.as) aliasMap.set(f.as, f.table);
        }
      }
    }
    // Single-table SELECT: the implicit "this is your column" table.
    const singleTable =
      Array.isArray(stmt.from) && stmt.from.length === 1 && typeof stmt.from[0]?.table === 'string'
        ? (stmt.from[0].table as string)
        : null;

    for (const col of stmt.columns ?? []) {
      const expr = col?.expr;
      if (!expr) continue;
      const fname = String(expr.name ?? '').toLowerCase();
      if (expr.type !== 'aggr_func' || fname !== 'avg') continue;
      const arg = expr.args?.expr;
      if (!arg || arg.type !== 'column_ref') continue;
      const colName = getColumnName(arg);
      const tableQual = getColumnTable(arg);
      const realTable = tableQual ? aliasMap.get(tableQual) ?? tableQual : singleTable;
      if (!colName || !realTable) continue;
      const t = tableByName.get(realTable);
      const c = t?.columns.find((cc) => cc.name === colName);
      if (!c?.nullable) continue;
      const key = `${realTable}.${colName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        id: 'AVG_OVER_NULLABLE',
        severity: 'suggestion',
        title: `AVG over nullable column "${realTable}.${colName}" silently ignores NULLs`,
        description:
          `AVG(${colName}) computes SUM / COUNT(${colName}), which excludes NULL rows from the denominator. ` +
          `If you intended "average across ALL rows including NULLs", the result will be different from what you expect.`,
        fix:
          `If you want NULLs treated as 0: AVG(COALESCE(${colName}, 0)). ` +
          `If you want the average over only non-NULL rows, the current query is correct — document the assumption.`,
        metadata: { table: realTable, column: colName },
      });
    }
  }
  return issues;
}

// ════════════════════════════════════════════════════════════════════════════
// Sprint 3 detectors
// ════════════════════════════════════════════════════════════════════════════

// Shared alias → real-table lookup for a single SELECT statement.
function buildAliasMap(stmt: any): Map<string, string> {
  const m = new Map<string, string>();
  if (Array.isArray(stmt?.from)) {
    for (const f of stmt.from) {
      if (typeof f?.table === 'string') {
        m.set(f.table, f.table);
        if (typeof f.as === 'string' && f.as) m.set(f.as, f.table);
      }
    }
  }
  return m;
}

const AGG_MEASURE_FUNCS = new Set(['sum', 'avg', 'min', 'max']);

function isCountStar(expr: any): boolean {
  if (!expr || expr.type !== 'aggr_func') return false;
  if (String(expr.name ?? '').toLowerCase() !== 'count') return false;
  if (expr.args?.distinct) return false;
  const arg = expr.args?.expr;
  return arg?.type === 'star' || arg?.column === '*' || arg?.value === '*';
}

function isCountAgg(node: any): boolean {
  return node?.type === 'aggr_func' && String(node.name ?? '').toLowerCase() === 'count';
}

// ── X3 / X4: Destructive DDL (DROP TABLE, TRUNCATE TABLE) — no schema ────────
function detectDestructiveDDL(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;
    const tableName =
      Array.isArray(stmt.name) && stmt.name[0]?.table ? String(stmt.name[0].table) : undefined;
    if (stmt.type === 'drop') {
      issues.push({
        id: 'DESTRUCTIVE_DDL',
        severity: 'error',
        title: `DROP ${stmt.keyword?.toUpperCase?.() ?? 'TABLE'} is irreversible`,
        description: `DROP permanently deletes ${tableName ? `"${tableName}"` : 'the object'} and all its data. This cannot be undone.`,
        fix: `If you only need to clear rows, use DELETE ... WHERE. If you must drop, take a backup first and run inside a transaction you can roll back.`,
        offendingClause: 'FROM',
        offendingTable: tableName,
        metadata: { table: tableName, operation: 'drop' },
      });
    } else if (stmt.type === 'truncate') {
      issues.push({
        id: 'DESTRUCTIVE_TRUNCATE',
        severity: 'error',
        title: `TRUNCATE removes every row in ${tableName ? `"${tableName}"` : 'the table'}`,
        description: `TRUNCATE deletes all rows and cannot be filtered with WHERE. In most engines it is not transactional and cannot be rolled back.`,
        fix: `If you meant to remove specific rows, use DELETE FROM ${tableName ?? 'table'} WHERE .... Only TRUNCATE when you intend to wipe the entire table.`,
        offendingClause: 'FROM',
        offendingTable: tableName,
        metadata: { table: tableName, operation: 'truncate' },
      });
    }
  }
  return issues;
}

// ── S3: Unknown alias (no schema) ────────────────────────────────────────────
// A column qualifier (`x.col`) that is neither a defined alias nor a table name
// in FROM/JOIN, nor a CTE / subquery alias.
function detectUnknownAlias(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const valid = new Set<string>();
    for (const n of collectLocalTableNames(stmt)) valid.add(n);
    if (Array.isArray(stmt.from)) {
      for (const f of stmt.from) {
        if (typeof f?.table === 'string') valid.add(f.table);
        if (typeof f?.as === 'string' && f.as) valid.add(f.as);
      }
    }
    if (valid.size === 0) continue; // nothing to resolve against (e.g. FROM subquery only)

    const seen = new Set<string>();
    const visit = (node: any) => {
      const q = getColumnTable(node);
      if (!q || valid.has(q) || seen.has(q)) return;
      seen.add(q);
      issues.push({
        id: 'UNKNOWN_ALIAS',
        severity: 'error',
        title: `Alias "${q}" is not defined`,
        description: `The query references "${q}.…" but no table or alias named "${q}" is defined in FROM / JOIN.`,
        fix: `Defined aliases in this query: ${[...valid].join(', ') || '(none)'}. Fix the qualifier or add "${q}" to FROM.`,
        offendingTable: q,
        metadata: { alias: q, defined: [...valid] },
      });
    };
    walkColumnRefs(stmt.columns, visit);
    walkColumnRefs(stmt.where, visit);
    walkColumnRefs(stmt.from, visit);
    walkColumnRefs(stmt.groupby, visit);
    walkColumnRefs(stmt.orderby, visit);
    walkColumnRefs(stmt.having, visit);
  }
  return issues;
}

// ── S4: Ambiguous unqualified column (schema required) ───────────────────────
function detectAmbiguousColumn(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from) || stmt.from.length < 2) continue;

    const fromTables = stmt.from
      .map((f: any) => (typeof f?.table === 'string' ? tableByName.get(f.table) : undefined))
      .filter(Boolean) as SchemaDefinition['tables'];
    if (fromTables.length < 2) continue;

    const selectAliases = new Set<string>();
    for (const c of stmt.columns ?? []) if (typeof c?.as === 'string' && c.as) selectAliases.add(c.as);

    const seen = new Set<string>();
    const visit = (node: any) => {
      if (getColumnTable(node)) return; // qualified — not ambiguous
      const name = getColumnName(node);
      if (!name || name === '*' || selectAliases.has(name)) return;
      const owners = fromTables.filter((t) => t.columns.some((c) => c.name === name));
      if (owners.length < 2 || seen.has(name)) return;
      seen.add(name);
      issues.push({
        id: 'AMBIGUOUS_COLUMN',
        severity: 'warning',
        title: `Column "${name}" is ambiguous`,
        description: `Column "${name}" exists on multiple tables in this query (${owners.map((o) => o.name).join(', ')}). The database cannot tell which one you mean.`,
        fix: `Qualify the column, e.g. ${owners[0].name}.${name} or ${owners[1].name}.${name}.`,
        offendingColumn: name,
        metadata: { column: name, tables: owners.map((o) => o.name) },
      });
    };
    walkColumnRefs(stmt.columns, visit);
    walkColumnRefs(stmt.where, visit);
    walkColumnRefs(stmt.groupby, visit);
    walkColumnRefs(stmt.orderby, visit);
    walkColumnRefs(stmt.having, visit);
  }
  return issues;
}

// ── J4 / J5: Cartesian join (no ON) and explicit CROSS JOIN — no schema ───────
function detectCartesianAndCrossJoin(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    for (const f of stmt.from) {
      if (!f?.join) continue;
      const jt = String(f.join).toUpperCase();
      const tableName = typeof f.table === 'string' ? f.table : f.as;
      if (jt === 'CROSS JOIN') {
        issues.push({
          id: 'CROSS_JOIN_RISK',
          severity: 'warning',
          title: `CROSS JOIN with "${tableName}" produces N×M rows`,
          description: `A CROSS JOIN pairs every row of one table with every row of "${tableName}". Confirm this Cartesian product is intentional.`,
          fix: `If not intentional, replace CROSS JOIN with an INNER/LEFT JOIN and add an ON condition relating the two tables.`,
          offendingClause: 'JOIN',
          offendingTable: tableName,
          metadata: { joinTable: tableName },
        });
      } else if (!f.on && !f.using) {
        issues.push({
          id: 'CARTESIAN_JOIN',
          severity: 'error',
          title: `JOIN with "${tableName}" has no ON clause`,
          description: `A JOIN without an ON (or USING) clause produces a Cartesian product: every row of the left side paired with every row of "${tableName}".`,
          fix: `Add a join condition, e.g. JOIN ${tableName} ON .... If a Cartesian product is intended, write CROSS JOIN explicitly.`,
          offendingClause: 'JOIN',
          offendingTable: tableName,
          metadata: { joinTable: tableName },
        });
      }
    }
  }
  return issues;
}

// ── J1: LEFT JOIN filtered in WHERE (no schema) ──────────────────────────────
// A predicate on the nullable (right) side of a LEFT JOIN, using a NULL-unsafe
// operator in WHERE, silently converts the LEFT JOIN to an INNER JOIN.
const NULL_UNSAFE_OPS = new Set([
  '=', '!=', '<>', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN',
]);

function detectLeftJoinFilteredInWhere(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !stmt.where || !Array.isArray(stmt.from)) continue;

    const nullable = new Map<string, string>(); // alias/table → display table
    for (const f of stmt.from) {
      if (f?.join && String(f.join).toUpperCase() === 'LEFT JOIN') {
        const real = typeof f.table === 'string' ? f.table : f.as;
        if (typeof f.table === 'string') nullable.set(f.table, real);
        if (typeof f.as === 'string' && f.as) nullable.set(f.as, real);
      }
    }
    if (nullable.size === 0) continue;

    const seen = new Set<string>();
    walkPredicates(stmt.where, (node: any) => {
      if (node?.type !== 'binary_expr') return;
      const op = String(node.operator ?? '').toUpperCase();
      if (!NULL_UNSAFE_OPS.has(op)) return;
      for (const side of [node.left, node.right]) {
        if (side?.type !== 'column_ref') continue;
        const q = getColumnTable(side);
        if (!q || !nullable.has(q)) continue;
        const col = getColumnName(side) ?? '<expr>';
        const tbl = nullable.get(q)!;
        const key = `${q}.${col}`;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push({
          id: 'LEFT_JOIN_FILTERED_IN_WHERE',
          severity: 'warning',
          title: `WHERE filter on "${q}.${col}" defeats the LEFT JOIN`,
          description: `Filtering on "${q}.${col}" in the WHERE clause converts the LEFT JOIN on "${tbl}" to an implicit INNER JOIN, dropping all rows with no match.`,
          fix: `Move the condition into the ON clause: LEFT JOIN ${tbl} ${q} ON ... AND ${q}.${col} ${op === '=' ? "= '...'" : op + ' ...'}`,
          offendingClause: 'WHERE',
          offendingTable: tbl,
          offendingColumn: col,
          metadata: { table: tbl, column: col, operator: op },
        });
        return;
      }
    });
  }
  return issues;
}

// Walk an ON tree, calling cb for each `=` binary_expr (descending AND/OR).
function forEachOnEquality(node: any, cb: (left: any, right: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'binary_expr') {
    const op = String(node.operator ?? '').toUpperCase();
    if (op === 'AND' || op === 'OR') {
      forEachOnEquality(node.left, cb);
      forEachOnEquality(node.right, cb);
      return;
    }
    if (op === '=') cb(node.left, node.right);
  }
}

// ── J3: Suspicious join key (schema optional) ────────────────────────────────
// Joining two identically-named columns (typically `id = id`) across tables is
// almost always a mistake — the FK column was meant instead.
function detectSuspiciousJoinKey(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  if (schema) for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    const aliasMap = buildAliasMap(stmt);
    const seen = new Set<string>();

    for (const f of stmt.from) {
      if (!f?.join || !f.on) continue;
      forEachOnEquality(f.on, (left: any, right: any) => {
        if (left?.type !== 'column_ref' || right?.type !== 'column_ref') return;
        const lcol = (getColumnName(left) ?? '').toLowerCase();
        const rcol = (getColumnName(right) ?? '').toLowerCase();
        const lq = getColumnTable(left);
        const rq = getColumnTable(right);
        if (!lcol || lcol !== rcol || lq === rq) return;
        if (lcol !== 'id') return; // only the high-confidence `id = id` shape
        const ltab = lq ? aliasMap.get(lq) ?? lq : '?';
        const rtab = rq ? aliasMap.get(rq) ?? rq : '?';
        const key = `${ltab}.${rtab}`;
        if (seen.has(key)) return;
        seen.add(key);

        // If schema knows a `<parent>_id` FK on either table, name it in the fix.
        let suggestion = '';
        const childFk = (childTab: string, parentTab: string) => {
          const t = tableByName.get(childTab);
          const guess = `${parentTab.replace(/s$/, '')}_id`;
          return t?.columns.some((c) => c.name === guess) ? guess : null;
        };
        const fk = (rq && childFk(rtab, ltab)) || (lq && childFk(ltab, rtab)) || null;
        if (fk) suggestion = ` The expected key is likely "${fk}".`;

        issues.push({
          id: 'SUSPICIOUS_JOIN_KEY',
          severity: 'warning',
          title: `Suspicious join key: ${ltab}.id = ${rtab}.id`,
          description: `Joining "${ltab}.id" to "${rtab}.id" matches primary keys directly. If "${rtab}" belongs to "${ltab}", the correct join uses a foreign key, not id = id.${suggestion}`,
          fix: `Verify the join key. A child→parent join usually reads like ${rtab}.${ltab.replace(/s$/, '')}_id = ${ltab}.id.`,
          offendingClause: 'JOIN',
          offendingTable: rtab,
          offendingColumn: 'id',
          metadata: { leftTable: ltab, rightTable: rtab },
        });
      });
    }
  }
  return issues;
}

// ── F1 / F2: Fan-out joins (no schema) ───────────────────────────────────────
// Two+ child tables joined to the SAME parent key cross-multiply. With a measure
// aggregate (SUM/AVG/MIN/MAX) it inflates the measure (F1); otherwise it's a
// multi-1:M count pattern (F2).
function detectFanOutJoins(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    // CTE / subquery-in-FROM targets are pre-collapsed (1:1 with their key), so
    // they don't fan out — exclude them to avoid flagging safe pre-aggregations.
    const local = collectLocalTableNames(stmt);
    const joins = stmt.from.filter(
      (f: any) => f?.join && f.on && typeof f.table === 'string' && !local.has(f.table),
    );
    if (joins.length < 2) continue;
    const aliasMap = buildAliasMap(stmt);

    // Collect the qualified join-key column refs for each join.
    const keyCount = new Map<string, number>();
    const perJoin: Array<{ table: string; keys: Set<string> }> = [];
    for (const j of joins) {
      const keys = new Set<string>();
      walkColumnRefs(j.on, (n: any) => {
        const q = getColumnTable(n);
        const c = getColumnName(n);
        if (q && c) keys.add(`${q}.${c}`);
      });
      perJoin.push({ table: typeof j.table === 'string' ? j.table : j.as, keys });
      for (const k of keys) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    }

    const sharedKey = [...keyCount.entries()].find(([, n]) => n >= 2)?.[0];
    if (!sharedKey) continue;
    const children = perJoin.filter((p) => p.keys.has(sharedKey)).map((p) => p.table);
    if (children.length < 2) continue;

    // Measure aggregate over a qualified column?
    let measure: { func: string; column: string; table: string } | null = null;
    for (const col of stmt.columns ?? []) {
      const e = col?.expr;
      if (e?.type !== 'aggr_func') continue;
      const fn = String(e.name ?? '').toLowerCase();
      if (!AGG_MEASURE_FUNCS.has(fn)) continue;
      const arg = e.args?.expr;
      if (arg?.type !== 'column_ref') continue;
      const q = getColumnTable(arg);
      const c = getColumnName(arg);
      if (!c) continue;
      measure = { func: fn.toUpperCase(), column: c, table: q ? aliasMap.get(q) ?? q : '?' };
      break;
    }

    if (measure) {
      const offending = children.find((t) => t !== measure!.table) ?? children[1];
      issues.push({
        id: 'AGGREGATE_OVER_FANOUT_JOIN',
        severity: 'warning',
        title: `${measure.func}(${measure.column}) is inflated by the join to "${offending}"`,
        description: `Joining "${offending}" alongside "${measure.table}" duplicates each "${measure.table}" row once per matching "${offending}" row, so ${measure.func}(${measure.column}) is multiplied.`,
        fix: `Pre-aggregate "${measure.table}" before joining: WITH agg AS (SELECT <fk>, ${measure.func}(${measure.column}) AS v FROM ${measure.table} GROUP BY <fk>) then join agg and "${offending}" separately.`,
        offendingClause: 'JOIN',
        offendingTable: offending,
        offendingColumn: measure.column,
        metadata: { measure: `${measure.func}(${measure.column})`, joinTable: offending, children },
      });
    } else {
      issues.push({
        id: 'MULTIPLE_ONE_TO_MANY_JOINS',
        severity: 'warning',
        title: `Multiple one-to-many joins cross-multiply (${children.join(', ')})`,
        description: `Joining both "${children[0]}" and "${children[1]}" to the same parent on the same key creates a cross-product of child rows per parent. Counts and sums across them will be wrong.`,
        fix: `Aggregate each child table separately in CTEs before joining: one CTE per child grouped by the foreign key, then LEFT JOIN the pre-aggregated results.`,
        offendingClause: 'JOIN',
        offendingTable: children[1],
        metadata: { children },
      });
    }
  }
  return issues;
}

// ── F4: SCD join without effective date (no schema) ──────────────────────────
const SCD_NAME_RE = /history|log|audit|version|snapshot/i;
const DATE_NAME_RE =
  /date|time|timestamp|valid|effective|created|updated|expire|_at|_from|_to|month|year|day/i;

function detectScdJoinWithoutEffectiveDate(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    for (const f of stmt.from) {
      if (!f?.join || typeof f.table !== 'string' || !SCD_NAME_RE.test(f.table)) continue;
      let hasDate = false;
      walkColumnRefs(f.on, (n: any) => {
        const c = getColumnName(n);
        if (c && DATE_NAME_RE.test(c)) hasDate = true;
      });
      if (hasDate) continue;
      issues.push({
        id: 'SCD_JOIN_WITHOUT_EFFECTIVE_DATE',
        severity: 'warning',
        title: `Slowly-changing dimension "${f.table}" joined without a date range`,
        description: `"${f.table}" looks like a history/audit table. Joining it without an effective-date condition can match multiple historical rows per record, inflating results.`,
        fix: `Add an effective-date range to the ON clause, e.g. AND <fact>.event_date >= ${f.table}.valid_from AND (${f.table}.valid_to IS NULL OR <fact>.event_date < ${f.table}.valid_to).`,
        offendingClause: 'JOIN',
        offendingTable: f.table,
        metadata: { table: f.table },
      });
    }
  }
  return issues;
}

// Recurse an expression for the first `/` binary_expr.
function findDivision(node: any): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'binary_expr' && String(node.operator) === '/') return node;
  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = findDivision(item);
        if (hit) return hit;
      }
    } else if (v && typeof v === 'object') {
      const hit = findDivision(v);
      if (hit) return hit;
    }
  }
  return null;
}

// Integer-type matcher for a DDL type string.
function isIntegerType(type: string | undefined): boolean {
  const t = String(type ?? '').toUpperCase();
  return (
    t === 'INT' || t === 'INTEGER' || t === 'BIGINT' || t === 'SMALLINT' || t.includes('SERIAL')
  );
}

// ── A1 / D13: Integer division truncation (schema-aware) ─────────────────────
// Division where BOTH operands are integer-producing truncates toward zero, so
// any true ratio < 1 silently becomes 0 (the analyst expects 0.73, gets 0).
// Integer-producing operands:
//   - COUNT(...)                         → always integer (no schema needed)
//   - integer literal                    → no schema needed
//   - a column typed INTEGER per schema  → e.g. completed / total
//   - SUM/MIN/MAX over an integer column → schema needed
// Without a schema only the COUNT / literal cases are detectable.
function detectIntegerDivision(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  if (schema) for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;

    const aliasMap = buildAliasMap(stmt);
    const singleTable =
      Array.isArray(stmt.from) && stmt.from.length === 1 && typeof stmt.from[0]?.table === 'string'
        ? (stmt.from[0].table as string)
        : null;

    // Resolve a column_ref's declared type via the schema, if known.
    const columnType = (node: any): string | null => {
      if (!schema || node?.type !== 'column_ref') return null;
      const colName = getColumnName(node);
      const q = getColumnTable(node);
      const realTable = q ? aliasMap.get(q) ?? q : singleTable;
      if (!colName || !realTable) return null;
      const t = tableByName.get(realTable);
      return t?.columns.find((c) => c.name === colName)?.type ?? null;
    };

    const isIntegerProducing = (n: any): boolean => {
      if (isCountAgg(n)) return true;
      if (n?.type === 'number' && Number.isInteger(n.value)) return true;
      if (n?.type === 'column_ref') return isIntegerType(columnType(n) ?? undefined);
      if (n?.type === 'aggr_func') {
        const fn = String(n.name ?? '').toLowerCase();
        if (fn === 'sum' || fn === 'min' || fn === 'max') {
          const arg = n.args?.expr;
          return arg?.type === 'column_ref' && isIntegerType(columnType(arg) ?? undefined);
        }
      }
      return false;
    };

    let flagged = false;
    for (const col of stmt.columns ?? []) {
      if (flagged) break;
      const div = findDivision(col?.expr);
      if (!div) continue;
      if (div.left?.type === 'cast' || div.right?.type === 'cast') continue; // already cast
      if (!isIntegerProducing(div.left) || !isIntegerProducing(div.right)) continue;
      flagged = true;
      issues.push({
        id: 'INTEGER_DIVISION_RISK',
        severity: 'warning',
        title: 'Integer division truncates toward zero',
        description: `Both sides of this division are integers (e.g. COUNT(...)/COUNT(...) or integer columns), so PostgreSQL performs integer division — any true ratio below 1 silently becomes 0.`,
        fix: `Cast the numerator to a decimal: CAST(numerator AS DECIMAL) / denominator, or numerator::decimal / denominator in PostgreSQL.`,
        offendingClause: 'SELECT',
        metadata: { operator: '/' },
      });
    }
  }
  return issues;
}

// ── A3: COUNT(*) after joining a child table (no schema) ──────────────────────
function detectCountParentAfterChildJoin(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    const joins = stmt.from.filter((f: any) => f?.join);
    if (joins.length === 0) continue;
    const childTable = typeof joins[0].table === 'string' ? joins[0].table : joins[0].as;
    for (const col of stmt.columns ?? []) {
      if (!isCountStar(col?.expr)) continue;
      issues.push({
        id: 'COUNT_PARENT_AFTER_CHILD_JOIN',
        severity: 'warning',
        title: 'COUNT(*) counts joined child rows, not parent rows',
        description: `After joining "${childTable}", COUNT(*) counts one row per matched child row rather than per parent. The total will be inflated.`,
        fix: `Count the parent's primary key distinctly: COUNT(DISTINCT <parent>.id) instead of COUNT(*).`,
        offendingClause: 'SELECT',
        offendingTable: childTable,
        metadata: { joinTable: childTable },
      });
      break; // one finding per statement
    }
  }
  return issues;
}

function isDateColumn(col: { name: string; type: string }): boolean {
  return /date|time|timestamp/i.test(col.type) || DATE_NAME_RE.test(col.name);
}

// ── T1: Revenue/SUM aggregate without a time filter (schema required) ─────────
// Scoped to queries that DO filter (have a WHERE) but omit a date predicate, so
// plain GROUP-BY rollups aren't nagged.
function detectMissingTimeFilter(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !stmt.where || !Array.isArray(stmt.from)) continue;

    const hasSum = (stmt.columns ?? []).some(
      (c: any) =>
        c?.expr?.type === 'aggr_func' &&
        ['sum', 'count'].includes(String(c.expr.name ?? '').toLowerCase()),
    );
    if (!hasSum) continue;

    const dateTable = stmt.from
      .map((f: any) => (typeof f?.table === 'string' ? tableByName.get(f.table) : undefined))
      .find((t: any) => t && t.columns.some((c: any) => isDateColumn(c)));
    if (!dateTable) continue;

    let hasDatePred = false;
    walkColumnRefs(stmt.where, (n: any) => {
      const c = getColumnName(n);
      if (c && DATE_NAME_RE.test(c)) hasDatePred = true;
    });
    if (hasDatePred) continue;

    issues.push({
      id: 'MISSING_TIME_FILTER',
      severity: 'warning',
      title: `Aggregate over "${dateTable.name}" has no time window`,
      description: `This query aggregates "${dateTable.name}" with a filter but no date condition, so it returns all-time totals rather than a reporting period.`,
      fix: `Add a date filter, e.g. AND ${dateTable.name}.created_at >= CURRENT_DATE - INTERVAL '30 days'.`,
      offendingClause: 'WHERE',
      offendingTable: dateTable.name,
      metadata: { table: dateTable.name },
    });
  }
  return issues;
}

// ── Dialect mismatch (raw-text, dialect-aware) ───────────────────────────────
// BigQuery-specific functions used while a non-BigQuery dialect is selected.
const BQ_ONLY_FUNCS = [
  'DATE_SUB', 'DATE_ADD', 'DATETIME_SUB', 'DATETIME_ADD', 'TIMESTAMP_SUB', 'TIMESTAMP_ADD',
  'FORMAT_DATE', 'PARSE_DATE', 'SAFE_DIVIDE', 'SAFE_CAST', 'GENERATE_DATE_ARRAY', 'GENERATE_ARRAY',
];

function detectDialectMismatch(sql: string, dialect: string): ValidationIssue[] {
  if (dialect === 'bigquery') return [];
  const issues: ValidationIssue[] = [];
  for (const fn of BQ_ONLY_FUNCS) {
    if (!new RegExp(`\\b${fn}\\s*\\(`, 'i').test(sql)) continue;
    const pgFix =
      fn === 'DATE_SUB'
        ? `PostgreSQL: CURRENT_DATE - INTERVAL '30 days'. Snowflake: DATEADD(day, -30, CURRENT_DATE()).`
        : `Use the ${dialect} equivalent of ${fn}().`;
    issues.push({
      id: 'DIALECT_MISMATCH',
      severity: 'warning',
      title: `"${fn}()" is BigQuery syntax, not ${dialect}`,
      description: `The function ${fn}() is BigQuery-specific and will not run in ${dialect}.`,
      fix: pgFix,
      offendingClause: 'WHERE',
      metadata: { function: fn, dialect },
    });
  }
  return issues;
}

// Find an `orderby` array anywhere under a window's OVER clause.
function findWindowOrderBy(node: any): any[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.orderby)) return node.orderby;
  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (v && typeof v === 'object') {
      const hit = findWindowOrderBy(v);
      if (hit) return hit;
    }
  }
  return null;
}

// ── WN1: Non-deterministic window order (no schema) ──────────────────────────
const RANKING_WINDOW_FUNCS = new Set(['row_number', 'rank', 'dense_rank']);

function detectNonDeterministicWindow(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const found = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'window_func' && node.over) {
      const fn = String(node.name ?? '').toLowerCase();
      if (RANKING_WINDOW_FUNCS.has(fn)) {
        const ob = findWindowOrderBy(node.over);
        if (ob && ob.length === 1 && !found.has(fn)) {
          found.add(fn);
          issues.push({
            id: 'NON_DETERMINISTIC_WINDOW_ORDER',
            severity: 'suggestion',
            title: `${fn.toUpperCase()}() has no tie-breaker in ORDER BY`,
            description: `${fn.toUpperCase()}() orders by a single column. When rows tie on that column, the assigned order is non-deterministic and can change between runs.`,
            fix: `Add a unique secondary sort key, e.g. ORDER BY <col> DESC, id DESC.`,
            offendingClause: 'SELECT',
            metadata: { windowFunc: fn },
          });
        }
      }
    }
    for (const key of Object.keys(node)) {
      const v = (node as any)[key];
      if (Array.isArray(v)) for (const item of v) visit(item);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  for (const stmt of asStatements(ast)) visit(stmt);
  return issues;
}

// ── D14: COUNT(nullable_col) vs COUNT(*) (schema required) ────────────────────
// COUNT(col) silently skips rows where col is NULL, so it can be lower than the
// COUNT(*) total an analyst expected. Distinct from D12 (which is about AVG).
function detectCountStarVsCountCol(ast: any, schema?: SchemaDefinition): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const tableByName = new Map<string, SchemaDefinition['tables'][number]>();
  for (const t of schema.tables) tableByName.set(t.name, t);

  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select') continue;
    const aliasMap = buildAliasMap(stmt);
    const singleTable =
      Array.isArray(stmt.from) && stmt.from.length === 1 && typeof stmt.from[0]?.table === 'string'
        ? (stmt.from[0].table as string)
        : null;
    const seen = new Set<string>();

    for (const col of stmt.columns ?? []) {
      const e = col?.expr;
      if (e?.type !== 'aggr_func' || String(e.name ?? '').toLowerCase() !== 'count') continue;
      if (e.args?.distinct) continue; // COUNT(DISTINCT col) is a deliberate choice
      const arg = e.args?.expr;
      if (!arg || arg.type !== 'column_ref') continue; // COUNT(*) is fine
      const colName = getColumnName(arg);
      const q = getColumnTable(arg);
      const realTable = q ? aliasMap.get(q) ?? q : singleTable;
      if (!colName || !realTable) continue;
      const t = tableByName.get(realTable);
      const c = t?.columns.find((cc) => cc.name === colName);
      if (!c) continue; // unknown column is D9's job
      if (!c.nullable) continue; // NOT NULL → COUNT(col) === COUNT(*), no risk
      const key = `${realTable}.${colName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        id: 'COUNT_STAR_VS_COUNT_COL',
        severity: 'suggestion',
        title: `COUNT(${colName}) skips NULL rows`,
        description: `"${realTable}.${colName}" is nullable, so COUNT(${colName}) counts only non-NULL values — it can be lower than the total row count.`,
        fix: `Use COUNT(*) if you want the total number of rows; keep COUNT(${colName}) only if you specifically want non-NULL ${colName} values.`,
        offendingClause: 'SELECT',
        offendingTable: realTable,
        offendingColumn: colName,
        metadata: { table: realTable, column: colName },
      });
    }
  }
  return issues;
}

// ── D15: HAVING without GROUP BY (no schema) ─────────────────────────────────
// HAVING filters aggregated groups; with no GROUP BY there is exactly one group
// (the whole table), so a HAVING here is almost always a misplaced WHERE.
function detectHavingWithoutGroupBy(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !stmt.having) continue;
    const gb = stmt.groupby;
    const hasGroupBy =
      !!gb && (Array.isArray(gb) ? gb.length > 0 : Array.isArray(gb.columns) ? gb.columns.length > 0 : false);
    if (hasGroupBy) continue;
    issues.push({
      id: 'HAVING_WITHOUT_GROUP_BY',
      severity: 'error',
      title: 'HAVING without GROUP BY',
      description: `This query has a HAVING clause but no GROUP BY. HAVING filters aggregated groups; with no GROUP BY the entire table is a single group, so the condition is almost certainly misplaced.`,
      fix: `Add a GROUP BY for the grain you want, or move the condition into the WHERE clause if it filters individual rows.`,
      offendingClause: 'HAVING',
      metadata: {},
    });
  }
  return issues;
}

// ════════════════════════════════════════════════════════════════════════════
// Sprint 3b detectors (additive — see task brief)
// ════════════════════════════════════════════════════════════════════════════

// Extract a function name from a node-sql-parser function/aggr node.
function getFunctionName(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type !== 'function' && node.type !== 'aggr_func') return null;
  const n = node.name;
  if (typeof n === 'string') return n;
  if (n && Array.isArray(n.name) && n.name[0]) {
    const first = n.name[0];
    return typeof first === 'string' ? first : (first.value ?? null);
  }
  return null;
}

// Walk an arbitrary AST subtree looking for a function call by name. Stops at
// nested SELECTs (their own scope).
function containsFunction(node: any, fnLower: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'select') return false;
  if (getFunctionName(node)?.toLowerCase() === fnLower) return true;
  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (Array.isArray(v)) {
      for (const item of v) if (containsFunction(item, fnLower)) return true;
    } else if (v && typeof v === 'object') {
      if (containsFunction(v, fnLower)) return true;
    }
  }
  return false;
}

// ── COALESCE_IN_JOIN_KEY (no schema) ─────────────────────────────────────────
// COALESCE() wrapping a join-key column defeats index use and can match
// unrelated rows (e.g. COALESCE(o.user_id, 0) = u.id matches u.id = 0).
function detectCoalesceInJoinKey(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from)) continue;
    const seen = new Set<string>();
    for (const f of stmt.from) {
      if (!f?.join || !f.on) continue;
      if (!containsFunction(f.on, 'coalesce')) continue;
      const tbl = typeof f.table === 'string' ? f.table : f.as;
      if (seen.has(String(tbl))) continue;
      seen.add(String(tbl));
      issues.push({
        id: 'COALESCE_IN_JOIN_KEY',
        severity: 'warning',
        title: `COALESCE in the JOIN key for "${tbl}"`,
        description: `Wrapping a join key in COALESCE() prevents index use and can match unrelated rows (a COALESCE default may equal a real key on the other side).`,
        fix: `COALESCE in join key prevents index use and may match unrelated rows. Use an IS NOT NULL filter instead.`,
        offendingClause: 'JOIN',
        offendingTable: typeof tbl === 'string' ? tbl : undefined,
        metadata: { joinTable: tbl },
      });
    }
  }
  return issues;
}

// ── WINDOW_MISSING_ORDER (no schema) ─────────────────────────────────────────
// A ranking window function with NO ORDER BY at all produces non-deterministic
// row numbers. (Complements NON_DETERMINISTIC_WINDOW_ORDER, which fires when an
// ORDER BY exists but has a single, possibly non-unique, key.)
function detectWindowMissingOrder(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'window_func' && node.over) {
      const fn = String(node.name ?? '').toLowerCase();
      if (RANKING_WINDOW_FUNCS.has(fn)) {
        const ob = findWindowOrderBy(node.over);
        if ((!ob || ob.length === 0) && !seen.has(fn)) {
          seen.add(fn);
          issues.push({
            id: 'WINDOW_MISSING_ORDER',
            severity: 'warning',
            title: `${fn.toUpperCase()}() has no ORDER BY`,
            description: `${fn.toUpperCase()}() without an ORDER BY assigns row numbers in an arbitrary, non-deterministic order that can change between runs.`,
            fix: `${fn.toUpperCase()}() without ORDER BY produces non-deterministic row numbers. Add ORDER BY created_at DESC (or another meaningful key).`,
            offendingClause: 'SELECT',
            metadata: { windowFunc: fn },
          });
        }
      }
    }
    for (const key of Object.keys(node)) {
      const v = (node as any)[key];
      if (Array.isArray(v)) for (const item of v) visit(item);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  for (const stmt of asStatements(ast)) visit(stmt);
  return issues;
}

// ── MISSING_TIME_FILTER — bare scan of an event/log table (no schema) ────────
// A full scan of an append-only event/log table with no date filter is almost
// always a mistake. Scoped to event-like table NAMES and to NON-aggregate
// queries, so it never overlaps the existing aggregate-based MISSING_TIME_FILTER.
const EVENT_TABLE_RE =
  /^(events?|logs?|audit_log|audit_logs|audit|activity|activities|sessions?|page_?views?|clicks?|impressions?|telemetry|event_log|access_log)$/i;

function detectMissingTimeFilterBareScan(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (stmt?.type !== 'select' || !Array.isArray(stmt.from) || stmt.from.length !== 1) continue;
    const f = stmt.from[0];
    if (typeof f?.table !== 'string' || !EVENT_TABLE_RE.test(f.table)) continue;
    // Skip aggregate queries — those are the existing detector's territory.
    if (hasAggregateFunction(stmt.columns)) continue;
    // Already has a date predicate in WHERE? Then it's filtered — don't flag.
    let hasDatePred = false;
    if (stmt.where) {
      walkColumnRefs(stmt.where, (n: any) => {
        const c = getColumnName(n);
        if (c && DATE_NAME_RE.test(c)) hasDatePred = true;
      });
    }
    if (hasDatePred) continue;
    issues.push({
      id: 'MISSING_TIME_FILTER',
      severity: 'warning',
      title: `No time filter on "${f.table}"`,
      description: `"${f.table}" looks like an append-only event/log table. Scanning it without a date filter reads the entire history and gets slower over time.`,
      fix: `Query has no time filter. Add WHERE created_at >= NOW() - INTERVAL '30 days' to limit the scan range.`,
      offendingClause: stmt.where ? 'WHERE' : 'FROM',
      offendingTable: f.table,
      metadata: { table: f.table, reason: 'bare_scan' },
    });
  }
  return issues;
}

// ── IMPLICIT_TIMEZONE (no schema) ────────────────────────────────────────────
// Comparing a date/time column to a naive timestamp string literal (no Z / no
// offset) can behave differently across server timezones.
const NAIVE_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?$/;
const HAS_TZ_RE = /[zZ]$|[+-]\d{2}:?\d{2}$/;

function isNaiveDateString(node: any): boolean {
  if (!node) return false;
  const isStr = node.type === 'single_quote_string' || node.type === 'string';
  if (!isStr || typeof node.value !== 'string') return false;
  return NAIVE_DATE_RE.test(node.value) && !HAS_TZ_RE.test(node.value);
}

const TZ_COMPARE_OPS = new Set(['>', '<', '>=', '<=', '=', '!=', '<>']);

function detectImplicitTimezone(ast: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stmt of asStatements(ast)) {
    if (!stmt) continue;
    const seen = new Set<string>();
    const visit = (node: any) => {
      if (node?.type !== 'binary_expr') return;
      const op = String(node.operator ?? '').toUpperCase();
      if (!TZ_COMPARE_OPS.has(op)) return;
      const sides = [node.left, node.right];
      const colNode = sides.find((s) => s?.type === 'column_ref');
      const litNode = sides.find((s) => isNaiveDateString(s));
      if (!colNode || !litNode) return;
      const col = getColumnName(colNode);
      if (!col || !DATE_NAME_RE.test(col)) return;
      if (seen.has(col)) return;
      seen.add(col);
      issues.push({
        id: 'IMPLICIT_TIMEZONE',
        severity: 'suggestion',
        title: `Timestamp compared to a timezone-naive literal ("${col}")`,
        description: `Comparing "${col}" to '${litNode.value}' (no timezone) can behave differently across server/session timezones.`,
        fix: `Timestamp comparison without timezone may behave differently across environments. Use '${litNode.value.slice(0, 10)}T00:00:00Z' or AT TIME ZONE 'UTC'.`,
        offendingClause: 'WHERE',
        offendingColumn: col,
        metadata: { column: col, literal: litNode.value },
      });
    };
    walkPredicates(stmt.where, visit);
    walkPredicates(stmt.having, visit);
  }
  return issues;
}

// ── DIALECT_MISMATCH — MySQL `LIMIT a,b` + SQL Server `TOP n` (raw text) ──────
// These constructs FAIL to parse under PostgreSQL/Snowflake/BigQuery, so this
// runs on the raw SQL (incl. from the parse-failure catch path) rather than the
// AST. We surface the dialect mismatch as the explanation for the parse failure.
function detectDialectLimitTop(sql: string, dialect: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // MySQL `LIMIT offset, count` — valid only in MySQL.
  const limitMatch = /\bLIMIT\s+(\d+)\s*,\s*(\d+)/i.exec(sql);
  if (limitMatch && dialect !== 'mysql') {
    const [, offset, count] = limitMatch;
    issues.push({
      id: 'DIALECT_MISMATCH',
      severity: 'warning',
      title: 'MySQL `LIMIT offset, count` syntax',
      description: `\`LIMIT ${offset}, ${count}\` is MySQL-specific and will not run in ${dialect}.`,
      fix: `LIMIT offset,count is MySQL syntax. In PostgreSQL use: LIMIT ${count} OFFSET ${offset}`,
      offendingClause: 'SELECT',
      metadata: { construct: 'mysql_limit', dialect },
    });
  }

  // SQL Server `SELECT TOP n` — not valid in any of our supported dialects.
  const topMatch = /\bSELECT\s+(?:DISTINCT\s+)?TOP\s+\(?\s*(\d+)/i.exec(sql);
  if (topMatch) {
    const [, n] = topMatch;
    issues.push({
      id: 'DIALECT_MISMATCH',
      severity: 'warning',
      title: 'SQL Server `TOP` syntax',
      description: `\`TOP ${n}\` is SQL Server-specific and will not run in ${dialect}.`,
      fix: `TOP is SQL Server syntax. In PostgreSQL use: LIMIT ${n}`,
      offendingClause: 'SELECT',
      metadata: { construct: 'sqlserver_top', dialect },
    });
  }

  return issues;
}
