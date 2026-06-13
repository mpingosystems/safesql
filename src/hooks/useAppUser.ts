import { useEffect, useState, useCallback } from 'react';
import { useUser } from '@clerk/clerk-react';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { isClerkConfigured } from '../components/AuthControls';

export type Plan = 'free' | 'pro' | 'team' | 'business';

export interface AppUser {
  id: string;
  // The Clerk user id (auth subject). Distinct from `id`, which is the Supabase
  // users.id. Stripe checkout/portal map to the user via this, since the users
  // table is keyed on clerk_user_id.
  clerkUserId: string;
  email: string;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  validations_this_month: number;
  sandbox_runs_this_month: number;
}

export interface UseAppUserResult {
  appUser: AppUser | null;
  isLoading: boolean;
  // True once Clerk has finished loading (or always true when Clerk isn't built
  // into this deployment). Checkout buttons gate on this so a click can't fire
  // before the Clerk user id is available to pass as clientReferenceId.
  isClerkReady: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const NOOP_REFRESH = async () => {};

// No-Clerk implementation: returns nulls, no hooks. Used when the build has
// no VITE_CLERK_PUBLISHABLE_KEY (deployments before auth is configured).
function useAppUserUnauth(): UseAppUserResult {
  return { appUser: null, isLoading: false, isClerkReady: true, error: null, refresh: NOOP_REFRESH };
}

// Clerk-enabled implementation: always calls useUser() (we know ClerkProvider
// is mounted in main.tsx when isClerkConfigured is true).
function useAppUserAuth(): UseAppUserResult {
  const { user, isLoaded, isSignedIn } = useUser();

  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrUpsert = useCallback(async () => {
    if (!isLoaded || !isSignedIn || !user) {
      setAppUser(null);
      return;
    }
    if (!isSupabaseConfigured) {
      // Clerk-only mode: synthesize a free-plan user so UI can show the avatar
      // and the editor stays usable. No row is created in Supabase.
      setAppUser({
        id: user.id,
        clerkUserId: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? '',
        plan: 'free',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        validations_this_month: 0,
        sandbox_runs_this_month: 0,
      });
      return;
    }

    const supabase = getSupabase();
    if (!supabase) {
      setAppUser(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const email = user.primaryEmailAddress?.emailAddress ?? '';
      const upsertRes = await supabase
        .from('users')
        .upsert(
          { clerk_user_id: user.id, email },
          { onConflict: 'clerk_user_id', ignoreDuplicates: false },
        )
        .select(
          'id, email, plan, stripe_customer_id, stripe_subscription_id, validations_this_month, sandbox_runs_this_month',
        )
        .single();

      if (upsertRes.error) throw new Error(upsertRes.error.message);
      setAppUser({ ...(upsertRes.data as AppUser), clerkUserId: user.id });
    } catch (e) {
      setError((e as Error).message);
      setAppUser(null);
    } finally {
      setIsLoading(false);
    }
  }, [isLoaded, isSignedIn, user]);

  useEffect(() => {
    void fetchOrUpsert();
  }, [fetchOrUpsert]);

  return { appUser, isLoading, isClerkReady: isLoaded, error, refresh: fetchOrUpsert };
}

// Module-level switch — bound at build time, so within any deployed bundle
// useAppUser always points at one implementation. React hooks rules satisfied.
export const useAppUser: () => UseAppUserResult = isClerkConfigured
  ? useAppUserAuth
  : useAppUserUnauth;

// Free-tier limits — single source of truth.
export const FREE_LIMITS = {
  validations: 50,
  sandbox_runs: 5,
} as const;

export function isOverValidationLimit(user: AppUser | null): boolean {
  if (!user) return false;
  if (user.plan !== 'free') return false;
  return user.validations_this_month >= FREE_LIMITS.validations;
}

export function isOverSandboxLimit(user: AppUser | null): boolean {
  if (!user) return false;
  if (user.plan !== 'free') return false;
  return user.sandbox_runs_this_month >= FREE_LIMITS.sandbox_runs;
}
