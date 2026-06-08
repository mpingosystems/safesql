import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

// Sprint 9 Part 3 — Query Library. Save validated queries, tag them, share them
// with the team. DB ops take an injectable Supabase client (default: the app
// singleton) so they're unit-testable with a fake, matching teams.ts/approvals.ts.

export interface SavedQuery {
  id: string;
  user_id: string;
  team_id: string | null;
  title: string;
  description: string | null;
  sql: string;
  ddl: string | null;
  dialect: string;
  tags: string[];
  last_risk_score: number | null;
  last_validated_at: string | null;
  is_team_shared: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface SavedQueryInput {
  userId: string;
  teamId?: string | null;
  title: string;
  description?: string;
  sql: string;
  ddl?: string;
  dialect?: string;
  tags?: string[];
  lastRiskScore?: number;
  isTeamShared?: boolean;
}

const COLS = 'id, user_id, team_id, title, description, sql, ddl, dialect, tags, last_risk_score, last_validated_at, is_team_shared, created_at, updated_at';

export async function saveQuery(
  input: SavedQueryInput,
  client: SupabaseClient | null = getSupabase(),
): Promise<SavedQuery | null> {
  if (!client || !input.userId || !input.title.trim() || !input.sql.trim()) return null;
  const { data, error } = await client
    .from('saved_queries')
    .insert({
      user_id: input.userId,
      team_id: input.teamId ?? null,
      title: input.title.trim(),
      description: input.description ?? null,
      sql: input.sql,
      ddl: input.ddl ?? null,
      dialect: input.dialect ?? 'postgresql',
      tags: input.tags ?? [],
      last_risk_score: input.lastRiskScore ?? null,
      last_validated_at: input.lastRiskScore != null ? new Date().toISOString() : null,
      is_team_shared: input.isTeamShared ?? false,
    })
    .select(COLS)
    .single();
  if (error || !data) return null;
  return data as SavedQuery;
}

export async function getMyQueries(
  userId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<SavedQuery[]> {
  if (!client || !userId) return [];
  const { data } = await client
    .from('saved_queries')
    .select(COLS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  return (data as SavedQuery[]) ?? [];
}

export async function getTeamQueries(
  teamId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<SavedQuery[]> {
  if (!client || !teamId) return [];
  const { data } = await client
    .from('saved_queries')
    .select(COLS)
    .eq('team_id', teamId)
    .eq('is_team_shared', true)
    .order('updated_at', { ascending: false });
  return (data as SavedQuery[]) ?? [];
}

export async function updateQuery(
  id: string,
  updates: Partial<SavedQueryInput>,
  client: SupabaseClient | null = getSupabase(),
): Promise<boolean> {
  if (!client || !id) return false;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.sql !== undefined) patch.sql = updates.sql;
  if (updates.ddl !== undefined) patch.ddl = updates.ddl;
  if (updates.tags !== undefined) patch.tags = updates.tags;
  if (updates.isTeamShared !== undefined) patch.is_team_shared = updates.isTeamShared;
  if (updates.lastRiskScore !== undefined) {
    patch.last_risk_score = updates.lastRiskScore;
    patch.last_validated_at = new Date().toISOString();
  }
  const { error } = await client.from('saved_queries').update(patch).eq('id', id);
  return !error;
}

export async function deleteQuery(
  id: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<boolean> {
  if (!client || !id) return false;
  const { error } = await client.from('saved_queries').delete().eq('id', id);
  return !error;
}

// Search the user's own queries by title, description, or tags (case-insensitive
// substring). Filtering happens in-memory over the user's set so behaviour is
// deterministic and storage-agnostic; the set is naturally small per user.
export async function searchQueries(
  userId: string,
  q: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<SavedQuery[]> {
  const all = await getMyQueries(userId, client);
  const needle = q.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((row) => {
    const hay = [row.title, row.description ?? '', ...(row.tags ?? [])].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}
