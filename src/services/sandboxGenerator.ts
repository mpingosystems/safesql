import type { SchemaColumn, SchemaDefinition, SchemaTable } from '../types/validation';

// SafeSQLSandboxGenerator — a lightweight, schema-faithful synthetic-data
// generator tuned for ONE job: produce 100–500 rows of realistic, constraint-
// respecting rows fast (sub-500ms for ~400 rows), synchronously, in the browser.
//
// This replaces the previous inline generator in sandboxRunner.ts. It is NOT the
// RealityDB CLI engine — that engine targets large-scale file export and is the
// wrong tool for an in-memory sandbox.

export interface SandboxGeneratorOptions {
  // Uniform row count for every table, or a per-table override map. Default 100.
  rowsPerTable?: number | Record<string, number>;
  seed?: number; // reproducible results for everything except UUID PKs
}

export function generateSandboxData(
  schema: SchemaDefinition,
  options: SandboxGeneratorOptions = {},
): string[] {
  const rng = makeRng(options.seed ?? 42);
  // PK value pools, keyed `table.column`, so FK columns can reference real
  // parent ids generated earlier in topological order.
  const pkPools = new Map<string, unknown[]>();
  const statements: string[] = [];

  for (const table of topologicalSort(schema.tables)) {
    const rows = rowsForTable(options.rowsPerTable, table.name);
    statements.push(...buildTableInserts(table, rows, rng, pkPools));
  }
  return statements;
}

function rowsForTable(
  rowsPerTable: number | Record<string, number> | undefined,
  tableName: string,
): number {
  if (typeof rowsPerTable === 'number') return rowsPerTable;
  if (rowsPerTable && typeof rowsPerTable === 'object') return rowsPerTable[tableName] ?? 100;
  return 100;
}

// ── Topological sort — parents before children ───────────────────────────────
// Copied from databox/packages/engine/src/engine.ts `topologicalSort` (DFS
// post-order over FK references), adapted to SafeSQL's SchemaTable shape. The
// engine is NOT imported — it is a CLI/Node module.
export function topologicalSort(tables: SchemaTable[]): SchemaTable[] {
  const tableMap = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const result: SchemaTable[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const table = tableMap.get(name);
    if (!table) return;
    for (const col of table.columns) {
      if (col.isFK && col.fkReferencesTable && col.fkReferencesTable !== name) {
        if (tableMap.has(col.fkReferencesTable)) visit(col.fkReferencesTable);
      }
    }
    result.push(table);
  }

  for (const table of tables) visit(table.name);
  return result;
}

// ── Per-table insert building ────────────────────────────────────────────────
function buildTableInserts(
  table: SchemaTable,
  rows: number,
  rng: Rng,
  pkPools: Map<string, unknown[]>,
): string[] {
  if (table.columns.length === 0) return [];
  const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ');
  const statements: string[] = [];

  // Per-column counters/sets for UNIQUE + sequential INTEGER PK generation.
  const seqCounters = new Map<string, number>();

  for (let i = 0; i < rows; i++) {
    const values: string[] = [];
    for (const col of table.columns) {
      const value = generateValue(table, col, i, rng, pkPools, seqCounters);
      if (col.isPK) {
        const key = `${table.name}.${col.name}`;
        if (!pkPools.has(key)) pkPools.set(key, []);
        pkPools.get(key)!.push(value);
      }
      values.push(toPgLiteral(value));
    }
    statements.push(`INSERT INTO ${quoteIdent(table.name)} (${colList}) VALUES (${values.join(', ')});`);
  }
  return statements;
}

// ── Value generation: constraint fidelity FIRST, then semantic, then type ─────
function generateValue(
  table: SchemaTable,
  col: SchemaColumn,
  rowIndex: number,
  rng: Rng,
  pkPools: Map<string, unknown[]>,
  seqCounters: Map<string, number>,
): unknown {
  // 1. FK columns reference an existing parent PK so JOINs actually match.
  if (col.isFK && col.fkReferencesTable && col.fkReferencesColumn) {
    const pool = pkPools.get(`${col.fkReferencesTable}.${col.fkReferencesColumn}`);
    if (pool && pool.length > 0) return rng.pick(pool);
    // Parent not seeded (e.g. cyclic FK) — fall through to type generation.
  }

  // 2. CHECK (col IN (...)) — weighted: first value 50%, the rest split the
  //    remaining 50% evenly. Highest priority after FK so we never violate it.
  if (Array.isArray(col.checkAllowedValues) && col.checkAllowedValues.length > 0) {
    return pickWeightedEnum(col.checkAllowedValues, rng);
  }

  const type = String(col.type ?? '').toUpperCase();
  const name = col.name.toLowerCase();
  const isIntType =
    type.includes('SERIAL') ||
    type === 'INT' ||
    type === 'INTEGER' ||
    type === 'BIGINT' ||
    type === 'SMALLINT';

  // 3. Primary keys must be unique.
  if (col.isPK) {
    if (type === 'UUID') return crypto.randomUUID();
    if (isIntType) {
      const key = `${table.name}.${col.name}`;
      const next = (seqCounters.get(key) ?? 0) + 1; // sequential 1,2,3…
      seqCounters.set(key, next);
      return next;
    }
    // Text/other PK — make it unique via the row index.
    return `${col.name}_${rowIndex + 1}`;
  }

  // 4. Semantic recognition by column-name substring (the realistic-data path).
  void isIntType; // (kept above for readability; typeFallbackValue recomputes)
  const semantic = semanticValue(name, type, rng);
  if (semantic !== undefined) return semantic;

  // 5. Type-based fallback.
  return typeFallbackValue(col.name, type, rng);
}

// Type-driven value for columns no semantic rule recognised. Used by both the
// main generator and the sampleColumnValue() test/preview helper.
function typeFallbackValue(originalName: string, type: string, rng: Rng): unknown {
  const t = String(type ?? '').toUpperCase();
  if (t === 'UUID') return crypto.randomUUID();
  if (t.includes('SERIAL') || t === 'INT' || t === 'INTEGER' || t === 'BIGINT' || t === 'SMALLINT') {
    return rng.int(1, 100_000);
  }
  if (
    t === 'NUMERIC' ||
    t === 'DECIMAL' ||
    t === 'REAL' ||
    t === 'DOUBLE' ||
    t.includes('DOUBLE') ||
    t === 'FLOAT' ||
    t.startsWith('NUMERIC')
  ) {
    return round2(rng.float(1, 10_000));
  }
  if (t === 'BOOLEAN' || t === 'BOOL') return rng.int(0, 1) === 1;
  if (t === 'DATE' || t.includes('TIMESTAMP')) return pastTimestamp(rng);
  // TEXT / VARCHAR / CHAR / anything else.
  return `${originalName}_${rng.int(1, 9999)}`;
}

// Test / preview helper: infer ONE realistic value from a column name (+ type).
// The production path is generateSandboxData(); generateValue() is internal and
// multi-arg, so this gives a stable single-column surface without changing it.
export function sampleColumnValue(columnName: string, type = 'text', seed = 1): unknown {
  const rng = makeRng(seed);
  const name = columnName.toLowerCase();
  const upperType = String(type).toUpperCase();
  const semantic = semanticValue(name, upperType, rng);
  return semantic !== undefined ? semantic : typeFallbackValue(columnName, upperType, rng);
}

// Substring-based semantic mapping. Returns undefined when no rule matches so
// the caller can fall back to type-based generation.
function semanticValue(name: string, type: string, rng: Rng): unknown {
  const isNumeric =
    type === 'NUMERIC' ||
    type === 'DECIMAL' ||
    type === 'REAL' ||
    type === 'DOUBLE' ||
    type.includes('DOUBLE') ||
    type === 'FLOAT' ||
    type.startsWith('NUMERIC') ||
    type === 'INT' ||
    type === 'INTEGER' ||
    type === 'BIGINT';

  if (name.includes('email')) {
    const user = rng.pick(FIRST_NAMES).toLowerCase();
    return `${user}${rng.int(1, 999)}@${rng.pick(DOMAINS)}`;
  }
  // country_code BEFORE country (country_code contains "country") and BEFORE the
  // name block (so "country_name" resolves to a country, not a person's name).
  if (name.includes('country') && (name.includes('code') || name.includes('iso'))) {
    return rng.pick(COUNTRY_CODES);
  }
  if (name.includes('country') || name.includes('nationality')) {
    return rng.pick(COUNTRIES);
  }
  // full_name / display_name / name → "First Last" (must contain a space).
  if (name === 'name' || name.includes('full_name') || name.includes('fullname') || name.endsWith('_name')) {
    if (name.includes('first')) return rng.pick(FIRST_NAMES);
    if (name.includes('last') || name.includes('sur')) return rng.pick(LAST_NAMES);
    if (name.includes('user') || name.includes('login') || name.includes('handle')) {
      return `${rng.pick(FIRST_NAMES).toLowerCase()}${rng.int(1, 99)}`;
    }
    if (name.includes('company') || name.includes('org') || name.includes('vendor') || name.includes('product')) {
      return `${rng.pick(LAST_NAMES)} ${rng.pick(COMPANY_SUFFIX)}`;
    }
    return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
  }
  if (name === 'first_name' || name.includes('firstname')) return rng.pick(FIRST_NAMES);
  if (name === 'last_name' || name.includes('lastname') || name.includes('surname')) return rng.pick(LAST_NAMES);
  if (name.includes('city') || name.includes('town')) return rng.pick(CITIES);
  if (name.includes('street') || name.includes('address')) {
    return `${rng.int(1, 9999)} ${rng.pick(STREET_NAMES)} ${rng.pick(STREET_TYPES)}`;
  }
  if (name.includes('zip') || name.includes('postal')) {
    return String(rng.int(10000, 99999));
  }
  if (
    name.includes('company') ||
    name.includes('vendor') ||
    name.includes('employer') ||
    name.includes('organization')
  ) {
    return `${rng.pick(LAST_NAMES)} ${rng.pick(COMPANY_SUFFIX)}`;
  }
  if (name.includes('phone') || name.includes('mobile') || name === 'tel') {
    return `+1${rng.int(2000000000, 9999999999)}`;
  }
  if (name === 'status' || name.endsWith('_status') || name.includes('state')) {
    return rng.pick(STATUSES);
  }
  if (
    name.includes('created') ||
    name.includes('updated') ||
    name.includes('_at') ||
    name.endsWith('date') ||
    name.includes('timestamp') ||
    name.includes('_on')
  ) {
    return pastTimestamp(rng);
  }
  // Money-ish numbers, normally distributed around a plausible mean.
  if (
    isNumeric &&
    (name.includes('amount') || name.includes('price') || name.includes('total') ||
      name.includes('cost') || name.includes('revenue') || name.includes('balance') ||
      name.includes('salary') || name.includes('fee'))
  ) {
    return round2(Math.max(0, normal(rng, 250, 120)));
  }
  if (isNumeric && (name.includes('quantity') || name.includes('qty') || name.includes('count') || name.includes('age'))) {
    return rng.int(1, 100);
  }
  return undefined;
}

// First value 50%; remaining values split the other 50% evenly.
function pickWeightedEnum<T>(values: readonly T[], rng: Rng): T {
  if (values.length === 1) return values[0];
  if (rng.float(0, 1) < 0.5) return values[0];
  const rest = values.slice(1);
  return rest[rng.int(0, rest.length - 1)];
}

// ── Sample pools ─────────────────────────────────────────────────────────────
const FIRST_NAMES: readonly string[] = [
  'Alice', 'Bob', 'Carlos', 'Diana', 'Edward', 'Fatima', 'George', 'Hannah', 'Ivan', 'Julia',
  'Kevin', 'Laura', 'Miguel', 'Nina', 'Oscar', 'Patricia', 'Quinn', 'Rachel', 'Samuel', 'Tanya',
  'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zachary',
];
const LAST_NAMES: readonly string[] = [
  'Johnson', 'Smith', 'Garcia', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Taylor',
  'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Young', 'Lewis',
];
const DOMAINS: readonly string[] = ['example.com', 'mail.io', 'corp.dev', 'acme.co', 'test.net'];
const STATUSES: readonly string[] = ['active', 'pending', 'completed', 'cancelled', 'inactive'];
// Full country names (was 2-letter codes — that's what COUNTRY_CODES is for).
const COUNTRIES: readonly string[] = [
  'United States', 'United Kingdom', 'Germany', 'France', 'Japan', 'Brazil', 'Canada', 'Australia',
  'India', 'Mexico', 'South Korea', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Switzerland',
  'Singapore', 'New Zealand', 'South Africa', 'Nigeria', 'Kenya', 'Argentina', 'Chile', 'Colombia',
  'Turkey', 'Poland', 'Czech Republic', 'Portugal', 'Spain', 'Italy', 'Greece', 'Egypt', 'Morocco',
];
const COUNTRY_CODES: readonly string[] = [
  'US', 'GB', 'DE', 'FR', 'JP', 'BR', 'CA', 'AU', 'IN', 'MX', 'KR', 'NL', 'SE', 'NO', 'DK', 'CH',
  'SG', 'NZ', 'ZA', 'NG', 'KE', 'AR', 'CL', 'CO', 'TR', 'PL', 'CZ', 'PT', 'ES', 'IT', 'GR', 'EG', 'MA',
];
const CITIES: readonly string[] = [
  'Austin', 'London', 'Toronto', 'Berlin', 'Paris', 'Tokyo', 'Madrid', 'Lagos', 'Mumbai', 'Sydney',
];
const STREET_NAMES: readonly string[] = [
  'Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Washington', 'Lincoln', 'Park', 'Lake', 'Hill',
];
const STREET_TYPES: readonly string[] = ['St', 'Ave', 'Blvd', 'Rd', 'Ln', 'Dr'];
const COMPANY_SUFFIX: readonly string[] = ['Inc', 'LLC', 'Group', 'Co', 'Labs'];

// ── RNG ──────────────────────────────────────────────────────────────────────
interface Rng {
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
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
  };
}

// Box–Muller normal sample (clamped by callers as needed).
function normal(rng: Rng, mean: number, stddev: number): number {
  const u1 = Math.max(1e-9, rng.float(0, 1));
  const u2 = rng.float(0, 1);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

function pastTimestamp(rng: Rng): string {
  const daysAgo = rng.int(0, 365);
  // Fixed epoch base keeps results reproducible (Date.now() would not be).
  const base = Date.parse('2026-06-01T00:00:00Z');
  return new Date(base - daysAgo * 86_400_000).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPgLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
