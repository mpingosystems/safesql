import type { SandboxResult, SchemaDefinition, SchemaTable } from '../types/validation';

// Lazy-load PGlite — its WASM bundle is ~7-10MB and we only want to ship it
// when the user actually clicks "Run sandbox".
type PGliteCtor = typeof import('@electric-sql/pglite').PGlite;
let pgliteCtorPromise: Promise<PGliteCtor> | null = null;
function loadPGlite(): Promise<PGliteCtor> {
  if (!pgliteCtorPromise) {
    pgliteCtorPromise = import('@electric-sql/pglite').then((m) => m.PGlite);
  }
  return pgliteCtorPromise;
}

export interface SandboxRunRequest {
  ddl: string;
  sql: string;
  schema: SchemaDefinition;
  expectedRows?: number;
  // Either a uniform row count for every table, or a per-table override map
  // (table-name → rows). Defaults to 100 for any table not specified.
  rowsPerTable?: number | Record<string, number>;
  seed?: number;
}

function rowsForTable(req: SandboxRunRequest, tableName: string): number {
  const r = req.rowsPerTable;
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') return r[tableName] ?? 100;
  return 100;
}

export async function runSandbox(req: SandboxRunRequest): Promise<SandboxResult> {
  const PGlite = await loadPGlite();
  const db = new PGlite();
  const rng = makeRng(req.seed ?? 42);
  resetSandboxState();

  try {
    await db.exec(req.ddl);

    for (const table of orderForInsertion(req.schema.tables)) {
      const inserts = buildInserts(table, rowsForTable(req, table.name), rng);
      if (inserts.length === 0) continue;
      await db.exec(inserts.join('\n'));
    }

    const start = performance.now();
    let rows: Record<string, unknown>[] = [];
    let executionError: string | undefined;
    try {
      const result = await db.query(req.sql);
      rows = (result.rows as Record<string, unknown>[]) ?? [];
    } catch (e) {
      executionError = (e as Error).message;
    }
    const executionMs = performance.now() - start;
    const totalRows = rows.length;

    const sandboxResult: SandboxResult = {
      rows: rows.slice(0, 50),
      totalRows,
      executionMs,
      expectedRows: req.expectedRows,
      executionError,
    };

    if (
      executionError === undefined &&
      typeof req.expectedRows === 'number' &&
      req.expectedRows > 0
    ) {
      const ratio = totalRows / req.expectedRows;
      sandboxResult.rowCountFlag = {
        expected: req.expectedRows,
        actual: totalRows,
        ratio,
        message: messageForRatio(ratio, req.expectedRows, totalRows),
      };
    }

    return sandboxResult;
  } finally {
    await db.close();
  }
}

function messageForRatio(ratio: number, expected: number, actual: number): string {
  if (ratio > 1.5) {
    return `Got ${actual} rows for ${expected} expected — JOIN multiplication is confirmed (${ratio.toFixed(1)}× inflation).`;
  }
  if (ratio < 0.5) {
    return `Got ${actual} rows for ${expected} expected — query is dropping rows you may want (${(ratio * 100).toFixed(0)}% of expected).`;
  }
  return `Got ${actual} rows for ${expected} expected (${ratio.toFixed(2)}× ratio).`;
}

// ── Insert ordering: parents before children so FKs resolve ─────────────────

function orderForInsertion(tables: SchemaTable[]): SchemaTable[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: SchemaTable[] = [];

  const visit = (t: SchemaTable) => {
    if (visited.has(t.name)) return;
    if (visiting.has(t.name)) return; // cycle — let caller handle
    visiting.add(t.name);
    for (const col of t.columns) {
      if (col.isFK && col.fkReferencesTable) {
        const parent = byName.get(col.fkReferencesTable);
        if (parent && parent !== t) visit(parent);
      }
    }
    visiting.delete(t.name);
    visited.add(t.name);
    ordered.push(t);
  };

  for (const t of tables) visit(t);
  return ordered;
}

// ── Synthetic data generation ───────────────────────────────────────────────

interface Rng {
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  uuid(): string;
}

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  return {
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    uuid: () => {
      // Deterministic UUID-shaped string from RNG (NOT cryptographically valid).
      // Sufficient for sandbox rows; real PII shouldn't end up here anyway.
      const hex = (n: number) =>
        Math.floor(next() * 16 ** n)
          .toString(16)
          .padStart(n, '0');
      return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
    },
  };
}

const generatedIds = new Map<string, unknown[]>(); // table.col → list of values

export function resetSandboxState(): void {
  generatedIds.clear();
}

function buildInserts(table: SchemaTable, rowsPerTable: number, rng: Rng): string[] {
  const cols = table.columns;
  if (cols.length === 0) return [];

  const colNames = cols.map((c) => quoteIdent(c.name)).join(', ');
  const inserts: string[] = [];

  for (let i = 0; i < rowsPerTable; i++) {
    const values: string[] = [];
    for (const col of cols) {
      const v = generateValue(table, col, rng);
      // Track PK values so children can reference them
      if (col.isPK) {
        const key = `${table.name}.${col.name}`;
        if (!generatedIds.has(key)) generatedIds.set(key, []);
        generatedIds.get(key)!.push(v);
      }
      values.push(toPgLiteral(v));
    }
    inserts.push(`INSERT INTO ${quoteIdent(table.name)} (${colNames}) VALUES (${values.join(', ')});`);
  }
  return inserts;
}

function generateValue(_table: SchemaTable, col: any, rng: Rng): unknown {
  // FK columns: pick from parent's PK pool (so JOINs actually match)
  if (col.isFK && col.fkReferencesTable && col.fkReferencesColumn) {
    const key = `${col.fkReferencesTable}.${col.fkReferencesColumn}`;
    const pool = generatedIds.get(key);
    if (pool && pool.length > 0) return rng.pick(pool);
    // Parent not yet seeded — fall through to type-based generation
  }

  const type = String(col.type ?? '').toUpperCase();

  if (type === 'UUID') return rng.uuid();
  if (type.includes('SERIAL') || type === 'INT' || type === 'INTEGER' || type === 'BIGINT' || type === 'SMALLINT') {
    return rng.int(1, 1_000_000);
  }
  if (type === 'NUMERIC' || type === 'DECIMAL' || type === 'REAL' || type === 'DOUBLE' || type === 'FLOAT') {
    return Math.round(rng.float(1, 10_000) * 100) / 100;
  }
  if (type === 'BOOLEAN' || type === 'BOOL') return rng.int(0, 1) === 1;
  if (type === 'DATE' || type === 'TIMESTAMP' || type.includes('TIMESTAMP') || type === 'TIMESTAMPTZ') {
    const daysAgo = rng.int(0, 365);
    const d = new Date(Date.now() - daysAgo * 86400_000);
    return d.toISOString();
  }
  // TEXT / VARCHAR / CHAR / anything else → short random string per column
  const sample = SAMPLES[col.name.toLowerCase() as keyof typeof SAMPLES];
  if (sample) return rng.pick(sample as readonly string[]);
  return `${col.name}_${rng.int(1, 9999)}`;
}

const SAMPLES = {
  email: ['alice@x.com', 'bob@y.io', 'carol@z.dev', 'dan@a.co', 'eve@b.net'],
  status: ['active', 'pending', 'cancelled', 'completed', 'inactive'],
  name: ['Alice', 'Bob', 'Carol', 'Dan', 'Eve', 'Frank', 'Grace'],
  first_name: ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'],
  last_name: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones'],
} as const;

function toPgLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
