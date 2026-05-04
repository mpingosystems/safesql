import { useAuth } from '@clerk/clerk-react';
import { useEffect } from 'react';
import { setSupabaseTokenSource } from '../services/supabaseClient';

// Mounted once inside ClerkProvider. Pipes the current Clerk session's
// getToken() into the Supabase client so RLS sees the right auth.jwt()->>sub.
// Renders nothing.
export function SupabaseAuthBridge() {
  const { getToken, isLoaded } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    setSupabaseTokenSource({
      // Clerk's default session token works directly with Supabase once
      // Supabase Auth → Third Party providers is configured to trust Clerk.
      getToken: () => getToken(),
    });
    return () => setSupabaseTokenSource(null);
  }, [getToken, isLoaded]);

  return null;
}
