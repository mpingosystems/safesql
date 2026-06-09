import {
  parseSnowflakeColumns,
  SNOWFLAKE_INFORMATION_SCHEMA_QUERY,
  type SnowflakeColumnRow,
} from '../../../src/services/schemaConnector';
import type { SchemaDefinition } from '../../../src/types/validation';

// Sprint 10 Part 3 — Snowflake schema introspection over the SQL API (REST, no
// npm package). v1 uses username/password Basic auth for simplicity; key-pair
// JWT auth is the hardening follow-up.

export interface SnowflakeConfig {
  type: 'snowflake';
  account: string; // e.g. xy12345.us-east-1
  username: string;
  password: string;
  warehouse: string;
  database: string;
  schema: string;
}

export async function fetchSnowflakeSchema(config: SnowflakeConfig): Promise<SchemaDefinition> {
  const url = `https://${config.account}.snowflakecomputing.com/api/v2/statements`;
  const basic = btoa(`${config.username}:${config.password}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      statement: SNOWFLAKE_INFORMATION_SCHEMA_QUERY(config.database, config.schema),
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
    }),
  });
  if (!res.ok) throw new Error(`Snowflake query failed (${res.status})`);

  const result = (await res.json()) as {
    resultSetMetaData?: { rowType?: { name: string }[] };
    data?: string[][];
  };

  // Snowflake returns data as arrays of strings ordered by resultSetMetaData.rowType.
  const cols = result.resultSetMetaData?.rowType?.map((c) => c.name.toUpperCase()) ?? [];
  const idx = (name: string) => cols.indexOf(name);
  const rows: SnowflakeColumnRow[] = (result.data ?? []).map((d) => ({
    TABLE_NAME: d[idx('TABLE_NAME')] ?? '',
    COLUMN_NAME: d[idx('COLUMN_NAME')] ?? '',
    DATA_TYPE: d[idx('DATA_TYPE')] ?? '',
    IS_NULLABLE: d[idx('IS_NULLABLE')] ?? 'YES',
    COLUMN_DEFAULT: d[idx('COLUMN_DEFAULT')] ?? null,
  }));

  return parseSnowflakeColumns(rows);
}
