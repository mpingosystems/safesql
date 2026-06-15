import { Parser } from 'node-sql-parser';
import type { SchemaDefinition } from '../types/validation';

// Join-cardinality proof for a fan-out / aggregation-grain bug. An aggregated
// query (GROUP BY) hides the multiplication in the SUM, not the row count — so a
// plain "rows returned" sandbox run can't show it. Instead we rewrite the query
// into:
//
//   SELECT COUNT(*) AS joined_rows, COUNT(DISTINCT <fact>.<pk>) AS grain_rows
//   FROM <the same FROM / JOIN / WHERE>
//
// `joined_rows / grain_rows` is exactly the factor by which SUM(<fact>...) is
// inflated. The FROM/JOIN/WHERE is preserved from the original query; only the
// SELECT/GROUP BY/ORDER BY/HAVING/LIMIT are rewritten.

const parser = new Parser();

// Value aggregates whose double-counting is the actual bug.
const VALUE_AGGS = new Set(['SUM', 'AVG', 'TOTAL']);

export interface FanoutProof {
  countQuery: string;
  factTable: string;
  factAlias: string;
}

function aggArgAlias(col: any): string | null {
  if (col?.expr?.type !== 'aggr_func') return null;
  const arg = col.expr.args?.expr;
  if (!arg || arg.type !== 'column_ref') return null;
  return typeof arg.table === 'string' && arg.table ? arg.table : null;
}

export function buildFanoutProofQuery(
  sql: string,
  schema: SchemaDefinition,
  dialect: string,
): FanoutProof | null {
  let ast: any;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch {
    return null;
  }
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  if (!stmt || stmt.type !== 'select' || !Array.isArray(stmt.from) || stmt.from.length < 2) return null;

  const cols: any[] = stmt.columns ?? [];
  // Prefer a value aggregate (SUM/AVG) — that's the inflated number; else any
  // aggregate over a qualified column.
  const target =
    cols.find((c) => c?.expr?.type === 'aggr_func' && VALUE_AGGS.has(String(c.expr.name).toUpperCase()) && aggArgAlias(c)) ??
    cols.find((c) => aggArgAlias(c));
  const factAlias = target ? aggArgAlias(target) : null;
  if (!factAlias) return null;

  // Resolve the alias → real table name from the FROM list.
  const fromEntry = stmt.from.find((f: any) => (f.as ?? f.table) === factAlias);
  const tableName: string | undefined = fromEntry?.table;
  if (!tableName) return null;

  // Primary key of the fact table (from the parsed schema).
  const tbl = schema.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
  const pk = tbl?.columns.find((c) => c.isPK)?.name;
  if (!pk) return null;

  // Build the COUNT columns by parsing a template (avoids hand-building AST).
  let tmplCols: any[];
  try {
    const tmpl: any = parser.astify(
      `SELECT COUNT(*) AS joined_rows, COUNT(DISTINCT ${factAlias}.${pk}) AS grain_rows FROM ${tableName}`,
      { database: dialect },
    );
    tmplCols = (Array.isArray(tmpl) ? tmpl[0] : tmpl).columns;
  } catch {
    return null;
  }

  // Graft onto a clone of the original statement (keeps FROM/JOIN/WHERE), strip
  // aggregating + ordering clauses, and serialize back to SQL.
  const proofStmt = { ...stmt, columns: tmplCols, groupby: null, orderby: null, having: null, limit: null };
  let countQuery: string;
  try {
    countQuery = parser.sqlify(proofStmt, { database: dialect });
  } catch {
    return null;
  }
  return { countQuery, factTable: tableName, factAlias };
}
