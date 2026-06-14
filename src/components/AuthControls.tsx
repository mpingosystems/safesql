import { SignInButton, SignedIn, SignedOut, UserButton, useUser } from '@clerk/clerk-react';
import { useState, useEffect } from 'react';

export const isClerkConfigured = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

interface AuthControlsProps {
  size?: 'sm' | 'md';
  signInMode?: 'modal' | 'redirect';
  signInLabel?: string;
  // Temporary: show a hint that Google OAuth is being configured (Sprint 11
  // Part 1). Remove once Google sign-in works on production — see
  // docs/google-oauth-setup.md.
  googleNotice?: boolean;
}

const GOOGLE_NOTICE = 'Google sign-in is being configured — please use email sign-in for now.';
const OAUTH_FAIL_NOTICE = "Google sign-in is temporarily unavailable. Please use email sign-in instead. We're working on it.";

// Clerk redirects an OAuth failure back with an error in the URL (e.g.
// ?err_code=authorization_invalid). Detect it, log the full context for
// debugging, and show a friendly message instead of a blank failure.
function OAuthErrorNotice() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const hay = `${window.location.search}${window.location.hash}`;
    if (/authorization_invalid|err_code=|__clerk_status=(failed|error)/i.test(hay)) {
      console.error('[oauth] Clerk OAuth failure detected in URL:', hay);
      setFailed(true);
    }
  }, []);
  if (!failed) return null;
  return <span style={{ fontSize: 10.5, color: '#fca5a5', maxWidth: 220, lineHeight: 1.3 }}>{OAUTH_FAIL_NOTICE}</span>;
}

export function AuthControls({ size = 'sm', signInMode = 'modal', signInLabel = 'Sign in', googleNotice = false }: AuthControlsProps) {
  if (!isClerkConfigured) {
    return (
      <span
        title="Clerk publishable key not configured (VITE_CLERK_PUBLISHABLE_KEY)"
        style={{ fontSize: 11, color: '#52525b' }}
      >
        Auth: off
      </span>
    );
  }

  return (
    <>
      <SignedOut>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <SignInButton mode={signInMode}>
            <button
              type="button"
              title={GOOGLE_NOTICE}
              style={{
                background: 'transparent',
                color: '#a78bfa',
                border: '1px solid #5b21b6',
                borderRadius: 5,
                padding: size === 'sm' ? '4px 12px' : '8px 16px',
                fontSize: size === 'sm' ? 12 : 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {signInLabel}
            </button>
          </SignInButton>
          {googleNotice && (
            <span style={{ fontSize: 10.5, color: '#71717a', maxWidth: 200, lineHeight: 1.3 }}>
              {GOOGLE_NOTICE}
            </span>
          )}
          <OAuthErrorNotice />
        </span>
      </SignedOut>
      <SignedIn>
        <UserButton
          afterSignOutUrl="/"
          appearance={{
            elements: {
              userButtonAvatarBox: { width: size === 'sm' ? 28 : 36, height: size === 'sm' ? 28 : 36 },
            },
          }}
        />
      </SignedIn>
    </>
  );
}

// Re-export the auth state hook for components that need user info inline.
export { useUser };

// Slot helpers — render children only when signed in / out.
// Falls back to "always render" when Clerk isn't configured.
export { SignedIn, SignedOut };

interface RequireAuthProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RequireAuth({ children, fallback }: RequireAuthProps) {
  if (!isClerkConfigured) return <>{children}</>;
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>{fallback ?? null}</SignedOut>
    </>
  );
}
