import type { SchemaDefinition, SchemaColumn } from '../types/validation';

// Sprint 9 Part 2 — Schema Connector. Eliminates the DDL-paste step by importing
// a database schema directly from INFORMATION_SCHEMA. This module is the pure,
// runtime-agnostic core (Web Crypto + plain parsing) shared by the Cloudflare
// Worker (functions/api/schema/sync.ts) and the unit tests. No raw connection
// strings ever touch this layer in plaintext at rest — they're AES-256-GCM
// encrypted with a key held only in the Worker (SCHEMA_ENCRYPTION_KEY).

export type ConnectorDialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

// PostgreSQL, BigQuery and Snowflake are live (Sprint 9 + Sprint 10). MySQL is
// still gated behind "Coming soon" so the UI/Function degrade gracefully.
export const SUPPORTED_DIALECTS: ConnectorDialect[] = ['postgresql', 'bigquery', 'snowflake'];

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

// ── BigQuery (Sprint 10) ─────────────────────────────────────────────────────
// INFORMATION_SCHEMA.COLUMNS rows. BigQuery has no PK/FK metadata in this view,
// so isPK/isFK are always false; partitioning columns are noted but not special.
export interface BigQueryColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
  is_partitioning_column?: string | null; // 'YES' | 'NO'
}

export function parseBigQueryColumns(rows: BigQueryColumnRow[]): SchemaDefinition {
  return groupColumns(
    rows.map((r) => ({
      table: r.table_name,
      column: r.column_name,
      type: normalizeType(r.data_type),
      nullable: String(r.is_nullable).toUpperCase() === 'YES',
    })),
  );
}

export const BIGQUERY_INFORMATION_SCHEMA_QUERY = (projectId: string, datasetId: string): string =>
  `SELECT table_name, column_name, data_type, is_nullable, is_partitioning_column
   FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
   ORDER BY table_name, ordinal_position;`;

// ── Snowflake (Sprint 10) ────────────────────────────────────────────────────
// Snowflake returns UPPERCASE column names from INFORMATION_SCHEMA.
export interface SnowflakeColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string; // 'YES' | 'NO'
  COLUMN_DEFAULT?: string | null;
}

export function parseSnowflakeColumns(rows: SnowflakeColumnRow[]): SchemaDefinition {
  return groupColumns(
    rows.map((r) => ({
      table: r.TABLE_NAME,
      column: r.COLUMN_NAME,
      type: normalizeType(r.DATA_TYPE),
      nullable: String(r.IS_NULLABLE).toUpperCase() === 'YES',
    })),
  );
}

export const SNOWFLAKE_INFORMATION_SCHEMA_QUERY = (database: string, schema: string): string =>
  `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
   FROM ${database}.INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = '${schema}'
   ORDER BY TABLE_NAME, ORDINAL_POSITION;`;

// Shared grouping for the dialects that expose only flat (table, column) rows.
interface FlatColumn {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

function groupColumns(rows: FlatColumn[]): SchemaDefinition {
  const tables = new Map<string, SchemaColumn[]>();
  for (const r of rows) {
    if (!r.table || !r.column) continue;
    if (!tables.has(r.table)) tables.set(r.table, []);
    tables.get(r.table)!.push({ name: r.column, type: r.type, nullable: r.nullable, isPK: false, isFK: false });
  }
  return { tables: [...tables.entries()].map(([name, columns]) => ({ name, columns })) };
}

// ── BigQuery service-account JWT (RS256) ─────────────────────────────────────
// Builds the signed assertion exchanged for an OAuth2 access token. Web Crypto
// (Node/vitest + Workers). nowSec is injected so it's deterministic in tests.
export interface BigQueryCredentials {
  client_email: string;
  private_key: string; // PEM (PKCS#8)
}

function b64urlFromString(s: string): string {
  return b64encode(new TextEncoder().encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromBytes(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return b64decode(body);
}

export async function createBigQueryJWT(creds: BigQueryCredentials, nowSec: number): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(creds.private_key) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput) as BufferSource),
  );
  return `${signingInput}.${b64urlFromBytes(sig)}`;
}
