import { STRIPE_PRICES } from '../config/stripe';
import { apiUrl } from '../config/api';

export type Plan = 'pro' | 'team' | 'business';
export type Cadence = 'monthly' | 'annual';

export function getPriceId(plan: Plan, cadence: Cadence = 'monthly'): string | null {
  return (STRIPE_PRICES[plan][cadence] as string | undefined) || null;
}

// Identity passed to the checkout session so the webhook can map the resulting
// subscription back to the user. clientReferenceId MUST be the Clerk user id
// (the users table is keyed on clerk_user_id).
export interface CheckoutIdentity {
  clientReferenceId?: string;
  customerEmail?: string;
}

export interface CheckoutResult {
  ok: boolean;
  reason?: 'missing-price-id' | 'backend-unreachable' | 'backend-error';
  message?: string;
}

export async function startCheckout(priceId: string, identity: CheckoutIdentity = {}): Promise<CheckoutResult> {
  if (!priceId) {
    return {
      ok: false,
      reason: 'missing-price-id',
      message:
        'Price ID not configured. Add the appropriate VITE_STRIPE_* price env var in Cloudflare Pages after creating prices in your Stripe dashboard.',
    };
  }

  const endpoint = apiUrl('/api/checkout');

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        priceId,
        clientReferenceId: identity.clientReferenceId,
        customerEmail: identity.customerEmail,
      }),
    });
  } catch {
    return {
      ok: false,
      reason: 'backend-unreachable',
      message:
        'Checkout backend unreachable. The Cloudflare Worker that creates Stripe Checkout Sessions is scheduled for Sprint 2.',
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: 'backend-error',
      message: `Checkout backend returned ${res.status}.`,
    };
  }

  const data = (await res.json()) as { url?: string };
  if (!data.url) {
    return { ok: false, reason: 'backend-error', message: 'Backend response missing checkout URL.' };
  }

  window.location.href = data.url;
  return { ok: true };
}

export async function startCheckoutForPlan(
  plan: Plan,
  cadence: Cadence = 'monthly',
  identity: CheckoutIdentity = {},
): Promise<CheckoutResult> {
  const priceId = getPriceId(plan, cadence);
  if (!priceId) {
    return {
      ok: false,
      reason: 'missing-price-id',
      message: `No price ID configured for ${plan} (${cadence}). Set VITE_STRIPE_${plan.toUpperCase()}_${cadence.toUpperCase()} in Cloudflare Pages env.`,
    };
  }
  return startCheckout(priceId, identity);
}
