import { getSupabase, isSupabaseConfigured } from './supabaseClient';

export interface PersistSandboxRunInput {
  appUserId: string;
  schemaId?: string;
}

// Records a sandbox execution against the user's monthly counter.
// PGlite runs are client-side and have no Neon branch, so neon_branch_id
// is a synthetic marker; expires_at is NOW() since the data is gone after
// the page closes.
// Fire-and-forget — never throws.
export async function persistSandboxRun(input: PersistSandboxRunInput): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const supabase = getSupabase();
  if (!supabase) return false;
  if (!input.appUserId) return false;

  try {
    const { error } = await supabase.from('sandboxes').insert({
      user_id: input.appUserId,
      schema_id: input.schemaId ?? null,
      neon_branch_id: `pglite-${Date.now()}`,
      expires_at: new Date().toISOString(),
    });
    if (error) {
      console.warn('persistSandboxRun failed', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('persistSandboxRun threw', e);
    return false;
  }
}
