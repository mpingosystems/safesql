import {
  BIGQUERY_INFORMATION_SCHEMA_QUERY,
  createBigQueryJWT,
  parseBigQueryColumns,
  type BigQueryColumnRow,
} from '../../../src/services/schemaConnector';
import type { SchemaDefinition } from '../../../src/types/validation';

// Sprint 10 Part 3 — BigQuery schema introspection over the REST API (no npm
// package). Service-account JWT → OAuth2 access token → jobs.query.

export interface BigQueryConfig {
  type: 'bigquery';
  project_id: string;
  dataset_id: string;
  credentials_json: string; // service-account JSON (stringified)
}

export async function fetchBigQuerySchema(config: BigQueryConfig): Promise<SchemaDefinition> {
  const creds = JSON.parse(config.credentials_json) as { client_email: string; private_key: string };
  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = await createBigQueryJWT(creds, nowSec);

  // Exchange the JWT for an access token.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`BigQuery auth failed (${tokenRes.status})`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Run the INFORMATION_SCHEMA query.
  const queryRes = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${config.project_id}/queries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: BIGQUERY_INFORMATION_SCHEMA_QUERY(config.project_id, config.dataset_id),
        useLegacySql: false,
      }),
    },
  );
  if (!queryRes.ok) throw new Error(`BigQuery query failed (${queryRes.status})`);
  const result = (await queryRes.json()) as {
    schema?: { fields?: { name: string }[] };
    rows?: { f: { v: string }[] }[];
  };

  // Map the tabular response (rows of cells, ordered by schema.fields) to typed rows.
  const fields = result.schema?.fields?.map((f) => f.name) ?? [];
  const idx = (name: string) => fields.indexOf(name);
  const rows: BigQueryColumnRow[] = (result.rows ?? []).map((r) => ({
    table_name: r.f[idx('table_name')]?.v ?? '',
    column_name: r.f[idx('column_name')]?.v ?? '',
    data_type: r.f[idx('data_type')]?.v ?? '',
    is_nullable: r.f[idx('is_nullable')]?.v ?? 'YES',
    is_partitioning_column: r.f[idx('is_partitioning_column')]?.v ?? 'NO',
  }));

  return parseBigQueryColumns(rows);
}
