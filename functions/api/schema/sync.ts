import { createClient } from '@supabase/supabase-js';
import type { Env } from '../../_shared';
import { hashApiKey } from '../../../src/services/apiKeys';
import { decryptConfig, isDialectSupported } from '../../../src/services/schemaConnector';
import { fetchBigQuerySchema } from './bigquery';
import { fetchSnowflakeSchema } from './snowflake';
import type { SchemaDefinition } from '../../../src/types/validation';

// Sprint 9 Part 2 — POST /api/schema/sync. Connects (read-only) to a stored
// database connection, runs INFORMATION_SCHEMA, converts to a SchemaDefinition,
// and caches it. Bearer API-key auth (Pro+). Decryption happens only here in the
// Worker — never in the browser.
//
// The core (handleSchemaSync) takes injectable deps so it's testable; the actual
// Postgres driver is provided by onRequestPost. v1 supports PostgreSQL only;
// other dialects return "Coming soon".

interface SchemaEnv extends Env {
  SCHEMA_ENCRYPTION_KEY: string;
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : null;
}

export interface ConnectionRow {
  id: string;
  dialect: string;
  encrypted_config: string;
}

export interface SchemaSyncDeps {
  authenticate(token: string | null): Promise<{ ok: boolean; userId?: string; plan?: string }>;
  getConnection(id: string, userId: string): Promise<ConnectionRow | null>;
  // Introspect the schema for a dialect from its (decrypted) config. Throws on
  // connection failure. PostgreSQL config is a connection string; BigQuery and
  // Snowflake configs are JSON blobs.
  fetchSchema(dialect: string, config: string): Promise<SchemaDefinition>;
  saveCache(id: string, schema: SchemaDefinition): Promise<void>;
  decrypt(payload: string): Promise<string>;
}

export async function handleSchemaSync(request: Request, deps: SchemaSyncDeps): Promise<Response> {
  let body: { connection_id?: unknown; test?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.connection_id !== 'string') {
    return jsonRes({ error: 'connection_id is required' }, 400);
  }

  const auth = await deps.authenticate(bearerToken(request));
  if (!auth.ok || !auth.userId) {
    return jsonRes({ error: 'Invalid API key. Get yours at https://safesqlpro.dev/settings' }, 401);
  }
  if (auth.plan === 'free') {
    return jsonRes({ error: 'Schema connections require Pro or above. Upgrade at https://safesqlpro.dev/pricing' }, 403);
  }

  const conn = await deps.getConnection(body.connection_id, auth.userId);
  if (!conn) return jsonRes({ error: 'Connection not found' }, 404);

  if (!isDialectSupported(conn.dialect)) {
    return jsonRes({ error: `${conn.dialect} connector is coming soon. PostgreSQL is supported today.` }, 400);
  }

  let config: string;
  try {
    config = await deps.decrypt(conn.encrypted_config);
  } catch {
    return jsonRes({ error: 'Could not decrypt connection config' }, 500);
  }

  let schema: SchemaDefinition;
  try {
    schema = await deps.fetchSchema(conn.dialect, config);
  } catch (e) {
    return jsonRes({ error: `Connection failed: ${(e as Error).message}` }, 502);
  }

  if (body.test !== true) {
    await deps.saveCache(conn.id, schema);
  }
  return jsonRes({ schema, tableCount: schema.tables.length }, 200);
}

// ── Cloudflare Pages Function wrappers ───────────────────────────────────────
export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export const onRequestPost = async (context: { request: Request; env: SchemaEnv }): Promise<Response> => {
  const { request, env } = context;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const deps: SchemaSyncDeps = {
    async authenticate(token) {
      if (!token) return { ok: false };
      const keyHash = await hashApiKey(token);
      const { data } = await supabase
        .from('api_keys')
        .select('user_id, plan, revoked_at')
        .eq('key_hash', keyHash)
        .maybeSingle();
      if (!data || data.revoked_at) return { ok: false };
      return { ok: true, userId: data.user_id as string, plan: data.plan as string };
    },
    async getConnection(id, userId) {
      const { data } = await supabase
        .from('schema_connections')
        .select('id, dialect, encrypted_config')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      return (data as ConnectionRow) ?? null;
    },
    async fetchSchema(dialect, config) {
      if (dialect === 'bigquery') return fetchBigQuerySchema(JSON.parse(config));
      if (dialect === 'snowflake') return fetchSnowflakeSchema(JSON.parse(config));
      // PostgreSQL: live TCP connectivity from a Worker needs a Hyperdrive binding
      // + a driver. Until that's provisioned we fail clearly. (BigQuery/Snowflake
      // go over HTTPS, so they work today without Hyperdrive.)
      void config;
      throw new Error('Postgres driver not provisioned (attach a Hyperdrive binding to enable live sync)');
    },
    async saveCache(id, schema) {
      await supabase
        .from('schema_connections')
        .update({ schema_cache: schema, last_synced_at: new Date().toISOString() })
        .eq('id', id);
    },
    decrypt(payload) {
      return decryptConfig(payload, env.SCHEMA_ENCRYPTION_KEY);
    },
  };

  return handleSchemaSync(request, deps);
};
