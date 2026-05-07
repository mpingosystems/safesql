import { Parser } from 'node-sql-parser';
import type { SchemaColumn, SchemaDefinition, SchemaTable } from '../types/validation';

const parser = new Parser();

type ParserDialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

// node-sql-parser v5 wraps identifiers as { expr: { type: 'default', value: 'name' } }.
// This helper digs through those wrappers and returns the bare string.
export function unwrapName(node: unknown): string | null {
  if (!node) return null;
  if (typeof node === 'string') return node;
  const n = node as any;
  if (typeof n.value === 'string') return n.value;
  if (typeof n.column === 'string') return n.column;
  if (n.column && typeof n.column === 'object') {
    const inner = unwrapName(n.column);
    if (inner) return inner;
  }
  if (n.expr) return unwrapName(n.expr);
  if (n.table && typeof n.table === 'string') return n.table;
  return null;
}

export function parseDDL(ddl: string, dialect: ParserDialect = 'postgresql'): SchemaDefinition {
  const tables: SchemaTable[] = [];

  const createStatements = ddl
    .split(/;\s*/)
    .filter((s) => s.trim().toUpperCase().startsWith('CREATE TABLE'));

  for (const stmt of createStatements) {
    try {
      const ast = parser.astify(stmt + ';', { database: dialect }) as unknown;
      const tableDef = (Array.isArray(ast) ? ast[0] : ast) as any;
      if (tableDef?.type !== 'create') continue;

      const tableName = unwrapName(tableDef.table?.[0]) ?? 'unknown';
      const defs: any[] = tableDef.create_definitions ?? [];
      const columns: SchemaColumn[] = [];

      for (const def of defs) {
        if (def.resource !== 'column') continue;

        const colName = unwrapName(def.column) ?? '';
        if (!colName) continue;

        // Inline PK
        const isPKInline =
          def.primary_key === 'primary key' ||
          def.primary_key === true ||
          def.unique === 'primary key';

        // Constraint-block PK referencing this column
        const isPKConstraint = defs.some(
          (c) =>
            c.resource === 'constraint' &&
            c.constraint_type === 'primary key' &&
            (c.definition ?? []).some((d: any) => unwrapName(d) === colName),
        );

        // Inline FK
        const inlineFKRef = def.reference_definition;
        const isFKInline = !!inlineFKRef;

        // Constraint-block FK referencing this column
        const constraintFK = defs.find(
          (c) =>
            c.resource === 'constraint' &&
            c.constraint_type === 'foreign key' &&
            (c.definition ?? []).some((d: any) => unwrapName(d) === colName),
        );

        const isFK = isFKInline || !!constraintFK;
        const fkRef = inlineFKRef ?? constraintFK?.reference_definition;

        const fkTable = fkRef?.table?.[0]?.table;
        const fkColumn = fkRef?.definition?.[0] ? unwrapName(fkRef.definition[0]) : undefined;

        // Nullable: absence of `nullable` field = nullable. `nullable.value === 'not null'` = NOT NULL.
        // Primary keys are implicitly NOT NULL in every SQL dialect — force false
        // even when the DDL doesn't spell it out, so detectors that key off
        // nullability (D6, D12, future D11-subquery resolution) don't false-positive.
        const isPK = isPKInline || isPKConstraint;
        const nullable = isPK ? false : def.nullable?.value !== 'not null';

        columns.push({
          name: colName,
          type: def.definition?.dataType ?? 'TEXT',
          nullable,
          isPK,
          isFK,
          fkReferencesTable: fkTable ?? undefined,
          fkReferencesColumn: fkColumn ?? undefined,
        });
      }

      const checkEnums = extractCheckEnums(stmt);
      for (const col of columns) {
        const allowed = checkEnums.get(col.name);
        if (allowed && allowed.length > 0) col.checkAllowedValues = allowed;
      }

      tables.push({ name: tableName, columns });
    } catch {
      // Skip unparseable statements
    }
  }

  return { tables };
}

// Extract `CHECK (col IN ('a','b','c'))` constraints from raw DDL text.
// node-sql-parser surfaces CHECK clauses inconsistently across dialects, so a
// targeted regex is more reliable for this specific (and very common) pattern.
// Returns a map of column-name → allowed string values.
export function extractCheckEnums(ddl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Matches:  CHECK ( <ident> IN ( 'a' , 'b' , ... ) )
  // - column ident may be bare or double-quoted
  // - allows arbitrary whitespace
  // - only quoted-string enum values (numeric IN-lists are skipped intentionally —
  //   downstream generation only needs string enums for the TEXT-column case)
  const re =
    /CHECK\s*\(\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+IN\s*\(\s*((?:'(?:[^']|'')*'\s*,?\s*)+)\)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ddl)) !== null) {
    const colName = m[1];
    const valuesPart = m[2];
    const values = [...valuesPart.matchAll(/'((?:[^']|'')*)'/g)].map((mm) =>
      mm[1].replace(/''/g, "'"),
    );
    if (values.length > 0) out.set(colName, values);
  }
  return out;
}
