import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const isSupabaseConfigured =
  !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_ANON_KEY;

// Lazily-created singleton. Created on first read; auth token is fetched
// per-request via the accessToken callback so it always reflects the current
// Clerk session without needing to recreate the client on sign-in/sign-out.
let client: SupabaseClient | null = null;

export interface ClerkSessionLike {
  // Returns a JWT to send with each request, or null if signed out.
  // In practice, this is `clerkInstance.session?.getToken()`.
  getToken: () => Promise<string | null>;
}

let tokenSource: ClerkSessionLike | null = null;

// Call once at app startup once Clerk is loaded — passes a function that
// returns the current Clerk session JWT. The Supabase client will call this
// on every query.
export function setSupabaseTokenSource(source: ClerkSessionLike | null): void {
  tokenSource = source;
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  client = createClient(url, anon, {
    accessToken: async () => {
      if (!tokenSource) return null;
      try {
        return await tokenSource.getToken();
      } catch {
        return null;
      }
    },
    auth: {
      // We use Clerk for sessions, so disable Supabase's own session handling.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}
