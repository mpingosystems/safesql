import { Parser } from 'node-sql-parser';
import type { SchemaColumn, SchemaDefinition, SchemaTable } from '../types/validation';

const parser = new Parser();

type ParserDialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake' | 'ansi';

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
        const nullable = def.nullable?.value !== 'not null';

        columns.push({
          name: colName,
          type: def.definition?.dataType ?? 'TEXT',
          nullable,
          isPK: isPKInline || isPKConstraint,
          isFK,
          fkReferencesTable: fkTable ?? undefined,
          fkReferencesColumn: fkColumn ?? undefined,
        });
      }

      tables.push({ name: tableName, columns });
    } catch {
      // Skip unparseable statements
    }
  }

  return { tables };
}
