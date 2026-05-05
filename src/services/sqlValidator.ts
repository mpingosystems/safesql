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
  issues.push(...detectHallucinatedTable(ast, request.schema));
  issues.push(...detectHallucinatedColumn(ast, request.schema));
  issues.push(...detectNullEqualityComparison(ast));
  issues.push(...detectNotInNullable(ast, request.schema));
  issues.push(...detectAvgOverNullable(ast, request.schema));

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

// ── D9: Hallucinated column (schema required, qualified-only v1) ────────────
// Only flags column refs that have a table qualifier resolvable to a known
// schema table. Skips bare `col` to avoid false positives from CTEs /
// subqueries / aliasing — those need a fuller resolver pass.
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

    const visit = (colNode: any) => {
      const tableQual = getColumnTable(colNode);
      const colName = getColumnName(colNode);
      if (!tableQual || !colName || colName === '*') return;
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
