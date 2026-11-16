import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { isClerkConfigured } from '../components/AuthControls';

// Returns a function that resolves the current Clerk session JWT, or null when
// signed out. When the build has no Clerk key, ClerkProvider isn't mounted and
// useAuth() would throw, so the module picks the no-auth variant up front (the
// same pattern as useAppUser).

type TokenGetter = () => Promise<string | null>;

const noToken: TokenGetter = async () => null;

function useSessionTokenUnauth(): TokenGetter {
  return noToken;
}

function useSessionTokenAuth(): TokenGetter {
  const { getToken } = useAuth();
  return useCallback(async () => (await getToken()) ?? null, [getToken]);
}

export const useSessionToken: () => TokenGetter = isClerkConfigured ? useSessionTokenAuth : useSessionTokenUnauth;
