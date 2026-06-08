import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import type { SchemaDefinition } from '../types/validation';

// Sprint 9 Part 2 — browser-side reads of the user's saved schema connections.
// The encrypted_config is NEVER selected client-side; only display fields and the
// cached SchemaDefinition (schema_cache) are read. Creation + sync go through the
// Cloudflare Worker (which holds the encryption key). Keyed by the same user id
// the sibling tables (api_keys, webhook_configs) use.

export interface SchemaConnectionSummary {
  id: string;
  name: string;
  dialect: string;
  last_synced_at: string | null;
  schema_cache: SchemaDefinition | null;
}

export async function listSchemaConnections(
  userId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<SchemaConnectionSummary[]> {
  if (!client || !userId) return [];
  const { data } = await client
    .from('schema_connections')
    .select('id, name, dialect, last_synced_at, schema_cache')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: false });
  return (data as SchemaConnectionSummary[]) ?? [];
}
