import type { SchemaDefinition, SchemaColumn } from '../types/validation';

// Sprint 9 Part 2 — Schema Connector. Eliminates the DDL-paste step by importing
// a database schema directly from INFORMATION_SCHEMA. This module is the pure,
// runtime-agnostic core (Web Crypto + plain parsing) shared by the Cloudflare
// Worker (functions/api/schema/sync.ts) and the unit tests. No raw connection
// strings ever touch this layer in plaintext at rest — they're AES-256-GCM
// encrypted with a key held only in the Worker (SCHEMA_ENCRYPTION_KEY).

export type ConnectorDialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

// Only PostgreSQL is live in v1; the rest are gated behind "Coming soon" so the
// UI/Function degrade gracefully instead of crashing.
export const SUPPORTED_DIALECTS: ConnectorDialect[] = ['postgresql'];

export function isDialectSupported(dialect: string): dialect is ConnectorDialect {
  return (SUPPORTED_DIALECTS as string[]).includes(dialect);
}

// ── AES-256-GCM encryption (Web Crypto: Node 18+/vitest + Cloudflare Workers) ──
// Key is 32 raw bytes, supplied base64. Output is base64(iv ‖ ciphertext); the
// 12-byte random IV is prepended so decrypt is self-describing.

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.length !== 32) throw new Error('SCHEMA_ENCRYPTION_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptConfig(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64encode(packed);
}

export async function decryptConfig(payloadB64: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const packed = b64decode(payloadB64);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// Generate a fresh base64 AES-256 key (helper for provisioning the secret).
export function generateEncryptionKey(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

// ── INFORMATION_SCHEMA → SchemaDefinition ────────────────────────────────────
// One row per (table, column) with optional constraint info. Multiple rows for
// the same column (e.g. it's both PK and FK) are folded together.
export interface InformationSchemaRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
  column_default?: string | null;
  constraint_type?: string | null; // 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | null
  foreign_table_name?: string | null;
  foreign_column_name?: string | null;
}

export function parseInformationSchema(rows: InformationSchemaRow[]): SchemaDefinition {
  const tables = new Map<string, Map<string, SchemaColumn>>();

  for (const r of rows) {
    if (!r.table_name || !r.column_name) continue;
    if (!tables.has(r.table_name)) tables.set(r.table_name, new Map());
    const cols = tables.get(r.table_name)!;

    const existing = cols.get(r.column_name);
    const isPK = r.constraint_type === 'PRIMARY KEY';
    const isFK = r.constraint_type === 'FOREIGN KEY';

    if (existing) {
      // Fold a second constraint row into the column we already have.
      existing.isPK = existing.isPK || isPK;
      existing.isFK = existing.isFK || isFK;
      if (isFK) {
        existing.fkReferencesTable = r.foreign_table_name ?? existing.fkReferencesTable;
        existing.fkReferencesColumn = r.foreign_column_name ?? existing.fkReferencesColumn;
      }
      continue;
    }

    const col: SchemaColumn = {
      name: r.column_name,
      type: normalizeType(r.data_type),
      nullable: String(r.is_nullable).toUpperCase() === 'YES',
      isPK,
      isFK,
    };
    if (isFK) {
      if (r.foreign_table_name) col.fkReferencesTable = r.foreign_table_name;
      if (r.foreign_column_name) col.fkReferencesColumn = r.foreign_column_name;
    }
    cols.set(r.column_name, col);
  }

  return {
    tables: [...tables.entries()].map(([name, cols]) => ({ name, columns: [...cols.values()] })),
  };
}

// Map a handful of Postgres type spellings to the canonical short forms the
// sandbox generator understands; pass anything else through unchanged.
function normalizeType(dataType: string): string {
  const t = dataType.toLowerCase().trim();
  const map: Record<string, string> = {
    'character varying': 'varchar',
    'character': 'char',
    'integer': 'int',
    'bigint': 'bigint',
    'smallint': 'smallint',
    'boolean': 'boolean',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'double precision': 'double',
    'numeric': 'numeric',
    'text': 'text',
    'uuid': 'uuid',
    'date': 'date',
    'json': 'json',
    'jsonb': 'jsonb',
  };
  return map[t] ?? t;
}

// The SQL the Worker runs against a connected Postgres database to enumerate the
// public schema (kept here so the Function and any docs share one definition).
export const POSTGRES_INFORMATION_SCHEMA_QUERY = `
  SELECT
    t.table_name,
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    tc.constraint_type,
    ccu.table_name  AS foreign_table_name,
    ccu.column_name AS foreign_column_name
  FROM information_schema.tables t
  JOIN information_schema.columns c
    ON c.table_name = t.table_name
   AND c.table_schema = t.table_schema
  LEFT JOIN information_schema.key_column_usage kcu
    ON kcu.column_name = c.column_name
   AND kcu.table_name = c.table_name
   AND kcu.table_schema = c.table_schema
  LEFT JOIN information_schema.table_constraints tc
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  LEFT JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND tc.constraint_type = 'FOREIGN KEY'
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
  ORDER BY t.table_name, c.ordinal_position;
`.trim();
