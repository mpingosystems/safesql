import { createClient } from '@supabase/supabase-js';
import type { Env } from '../../_shared';
import { hashApiKey } from '../../../src/services/apiKeys';
import { encryptConfig, isDialectSupported } from '../../../src/services/schemaConnector';

// Sprint 9 Part 2 — POST /api/schema/connections. Creates a schema connection.
// The raw connection string is encrypted here in the Worker (AES-256-GCM,
// SCHEMA_ENCRYPTION_KEY) and only the ciphertext is persisted. Bearer API-key
// auth (Pro+).

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

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export const onRequestPost = async (context: { request: Request; env: SchemaEnv }): Promise<Response> => {
  const { request, env } = context;
  let body: { name?: unknown; dialect?: unknown; connection_string?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const dialect = typeof body.dialect === 'string' ? body.dialect : '';
  const connectionString = typeof body.connection_string === 'string' ? body.connection_string : '';
  if (!name || !dialect || !connectionString) {
    return jsonRes({ error: 'name, dialect and connection_string are required' }, 400);
  }
  if (!isDialectSupported(dialect)) {
    return jsonRes({ error: `${dialect} connector is coming soon. PostgreSQL is supported today.` }, 400);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const token = bearerToken(request);
  if (!token) return jsonRes({ error: 'Invalid API key' }, 401);
  const keyHash = await hashApiKey(token);
  const { data: key } = await supabase
    .from('api_keys')
    .select('user_id, plan, revoked_at')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (!key || key.revoked_at) return jsonRes({ error: 'Invalid API key' }, 401);
  if (key.plan === 'free') return jsonRes({ error: 'Schema connections require Pro or above.' }, 403);

  let encrypted_config: string;
  try {
    encrypted_config = await encryptConfig(connectionString, env.SCHEMA_ENCRYPTION_KEY);
  } catch {
    return jsonRes({ error: 'Server is missing SCHEMA_ENCRYPTION_KEY' }, 500);
  }

  const { data, error } = await supabase
    .from('schema_connections')
    .insert({
      user_id: key.user_id,
      name,
      dialect,
      connection_type: 'connection_string',
      encrypted_config,
    })
    .select('id, name, dialect')
    .single();
  if (error) return jsonRes({ error: error.message }, 500);
  return jsonRes({ connection: data }, 201);
};
