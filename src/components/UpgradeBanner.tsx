import { useState } from 'react';
import { startCheckoutForPlan, type Cadence, type Plan } from '../services/stripe';
import { useAppUser } from '../hooks/useAppUser';

interface UpgradeBannerProps {
  plan?: Plan;
  cadence?: Cadence;
  reason?: string;
  onDismiss?: () => void;
}

export function UpgradeBanner({
  plan = 'pro',
  cadence = 'monthly',
  reason = "You've used your free validations for the month.",
  onDismiss,
}: UpgradeBannerProps) {
  const { appUser, isClerkReady } = useAppUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setBusy(true);
    setError(null);
    const result = await startCheckoutForPlan(plan, cadence, {
      clientReferenceId: appUser?.clerkUserId,
      customerEmail: appUser?.email,
    });
    setBusy(false);
    if (!result.ok) setError(result.message ?? 'Checkout failed.');
  };

  return (
    <div
      role="region"
      aria-label="Upgrade prompt"
      style={{
        background: 'linear-gradient(90deg, #1e1b4b 0%, #4c1d95 100%)',
        border: '1px solid #5b21b6',
        borderRadius: 8,
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        margin: '12px 0',
        color: '#e4e4e7',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{reason}</div>
        <div style={{ fontSize: 12, color: '#c4b5fd' }}>
          Upgrade to <strong>{plan === 'pro' ? 'Pro' : plan === 'team' ? 'Team' : 'Business'}</strong> for unlimited validations + AI explanations.
        </div>
        {error && (
          <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6 }}>{error}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => void handleUpgrade()}
        disabled={busy || !isClerkReady}
        style={{
          background: '#fbbf24',
          color: '#0a0a0a',
          border: 'none',
          borderRadius: 5,
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 700,
          cursor: busy ? 'wait' : !isClerkReady ? 'not-allowed' : 'pointer',
          opacity: busy || !isClerkReady ? 0.7 : 1,
        }}
      >
        {busy || !isClerkReady ? 'Loading…' : 'Upgrade →'}
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#a78bfa',
            cursor: 'pointer',
            fontSize: 18,
            padding: 4,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
