import type { CustomRule, SchemaDefinition, ValidationIssue } from '../types/validation';

// Sprint 8 Part 5 — team custom rule engine. Evaluates company-specific SQL
// policy after the built-in detectors. Self-contained AST helpers (node-sql-parser
// shapes) so it doesn't couple to sqlValidator internals.

function asStmts(ast: unknown): any[] {
  return Array.isArray(ast) ? ast : ast ? [ast] : [];
}

// All table names referenced in FROM / JOIN across the query.
function fromTables(ast: unknown): string[] {
  const names: string[] = [];
  for (const stmt of asStmts(ast)) {
    if (!Array.isArray((stmt as any)?.from)) continue;
    for (const f of (stmt as any).from) {
      if (typeof f?.table === 'string') names.push(f.table);
    }
  }
  return names;
}

// Bare column name of a column_ref (handles node-sql-parser v5 wrapping).
function colName(node: any): string | null {
  if (!node || node.type !== 'column_ref') return null;
  const c = node.column;
  if (typeof c === 'string') return c;
  if (c?.expr?.value) return c.expr.value;
  return null;
}

// Collect every column name referenced anywhere in a subtree (WHERE/ON/etc).
function collectColumns(node: any, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'column_ref') {
    const n = colName(node);
    if (n) out.add(n.toLowerCase());
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((i) => collectColumns(i, out));
    else if (v && typeof v === 'object') collectColumns(v, out);
  }
}

function whereColumns(stmt: any): Set<string> {
  const out = new Set<string>();
  collectColumns(stmt?.where, out);
  return out;
}

function str(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === 'string' ? (config[key] as string) : '';
}

export function evaluateCustomRules(
  sql: string,
  ast: unknown,
  schema: SchemaDefinition | undefined,
  rules: CustomRule[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(rules) || rules.length === 0) return issues;

  const tables = fromTables(ast).map((t) => t.toLowerCase());
  const stmts = asStmts(ast);

  for (const rule of rules) {
    if (rule.active === false) continue;
    const fired = ruleFires(rule, sql, ast, stmts, tables, schema);
    if (!fired) continue;
    const message = str(rule.config, 'message') || rule.description || `Custom rule "${rule.name}" matched.`;
    issues.push({
      id: 'CUSTOM_RULE',
      severity: rule.severity ?? 'warning',
      title: `Custom rule: ${rule.name}`,
      description: `${rule.name}: ${message}`,
      fix: message,
      metadata: { ruleId: rule.id, ruleName: rule.name, ruleType: rule.rule_type },
    });
  }
  return issues;
}

function ruleFires(
  rule: CustomRule,
  sql: string,
  ast: unknown,
  stmts: any[],
  tables: string[],
  schema: SchemaDefinition | undefined,
): boolean {
  const cfg = rule.config ?? {};
  switch (rule.rule_type) {
    case 'forbidden_pattern': {
      const pattern = str(cfg, 'pattern');
      if (!pattern) return false;
      try {
        return new RegExp(pattern, 'i').test(sql);
      } catch {
        return sql.toLowerCase().includes(pattern.toLowerCase());
      }
    }
    case 'forbidden_table': {
      const table = str(cfg, 'table').toLowerCase();
      return !!table && tables.includes(table);
    }
    case 'required_filter': {
      const table = str(cfg, 'table').toLowerCase();
      const column = str(cfg, 'column').toLowerCase();
      if (!table || !column) return false;
      if (!tables.includes(table)) return false;
      // Fire when the table is queried but no WHERE references the column.
      for (const stmt of stmts) {
        const cols = whereColumns(stmt);
        if (!cols.has(column)) return true;
      }
      return false;
    }
    case 'required_join_condition': {
      const table = str(cfg, 'table').toLowerCase();
      const required = str(cfg, 'required_column').toLowerCase();
      if (!table || !required) return false;
      if (!tables.includes(table)) return false;
      // Fire when the table is present but the required column appears in neither
      // an ON clause nor WHERE.
      for (const stmt of stmts) {
        const cols = new Set<string>();
        collectColumns(stmt?.where, cols);
        if (Array.isArray(stmt?.from)) for (const f of stmt.from) collectColumns(f?.on, cols);
        if (!cols.has(required)) return true;
      }
      return false;
    }
    case 'required_column_qualification': {
      const table = str(cfg, 'table').toLowerCase();
      if (!table || !tables.includes(table) || tables.length < 2) return false;
      // Fire when a multi-table query references an unqualified column that
      // belongs to the named table (per schema).
      const t = schema?.tables.find((x) => x.name.toLowerCase() === table);
      const tableCols = new Set((t?.columns ?? []).map((c) => c.name.toLowerCase()));
      let fires = false;
      for (const stmt of stmts) {
        const visit = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (node.type === 'column_ref') {
            const qualified = typeof node.table === 'string' && node.table.length > 0;
            const n = colName(node)?.toLowerCase();
            if (!qualified && n && (tableCols.size === 0 ? true : tableCols.has(n))) fires = true;
            return;
          }
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v === 'object') visit(v);
          }
        };
        visit(stmt?.columns);
      }
      void ast;
      return fires;
    }
    default:
      return false;
  }
}
