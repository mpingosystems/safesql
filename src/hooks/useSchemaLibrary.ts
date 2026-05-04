import { useCallback, useEffect, useState } from 'react';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';

export interface SavedSchema {
  id: string;
  name: string;
  ddl: string;
  dialect: string;
  created_at: string;
  updated_at: string;
}

export interface UseSchemaLibraryResult {
  schemas: SavedSchema[];
  isLoading: boolean;
  error: string | null;
  saveSchema: (input: { name: string; ddl: string; dialect?: string }) => Promise<SavedSchema | null>;
  deleteSchema: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

// Hook returns the current user's saved schemas. RLS scopes the SELECT
// to rows where users.id matches the JWT sub. When Supabase or auth isn't
// configured, the hook returns empty + no-op writers (UI stays passive).
export function useSchemaLibrary(appUserId: string | null): UseSchemaLibraryResult {
  const [schemas, setSchemas] = useState<SavedSchema[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured || !appUserId) {
      setSchemas([]);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;

    setIsLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('schemas')
        .select('id, name, ddl, dialect, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (err) throw new Error(err.message);
      setSchemas((data ?? []) as SavedSchema[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [appUserId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSchema = useCallback(
    async (input: { name: string; ddl: string; dialect?: string }): Promise<SavedSchema | null> => {
      if (!isSupabaseConfigured || !appUserId) return null;
      const supabase = getSupabase();
      if (!supabase) return null;

      try {
        const { data, error: err } = await supabase
          .from('schemas')
          .insert({
            user_id: appUserId,
            name: input.name,
            ddl: input.ddl,
            dialect: input.dialect ?? 'postgresql',
          })
          .select('id, name, ddl, dialect, created_at, updated_at')
          .single();
        if (err) throw new Error(err.message);
        const saved = data as SavedSchema;
        setSchemas((prev) => [saved, ...prev]);
        return saved;
      } catch (e) {
        setError((e as Error).message);
        return null;
      }
    },
    [appUserId],
  );

  const deleteSchema = useCallback(
    async (id: string): Promise<boolean> => {
      if (!isSupabaseConfigured || !appUserId) return false;
      const supabase = getSupabase();
      if (!supabase) return false;

      try {
        const { error: err } = await supabase.from('schemas').delete().eq('id', id);
        if (err) throw new Error(err.message);
        setSchemas((prev) => prev.filter((s) => s.id !== id));
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [appUserId],
  );

  return { schemas, isLoading, error, saveSchema, deleteSchema, refresh };
}
