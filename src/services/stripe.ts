export type Plan = 'pro' | 'team' | 'business';
export type Cadence = 'monthly' | 'annual';

const PRICE_IDS: Record<Plan, Record<Cadence, string | undefined>> = {
  pro: {
    monthly: import.meta.env.VITE_STRIPE_PRO_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_PRO_ANNUAL_PRICE_ID,
  },
  team: {
    monthly: import.meta.env.VITE_STRIPE_TEAM_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_TEAM_ANNUAL_PRICE_ID,
  },
  business: {
    monthly: import.meta.env.VITE_STRIPE_BUSINESS_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_BUSINESS_ANNUAL_PRICE_ID,
  },
};

export function getPriceId(plan: Plan, cadence: Cadence = 'monthly'): string | null {
  return PRICE_IDS[plan][cadence] || null;
}

export interface CheckoutResult {
  ok: boolean;
  reason?: 'missing-price-id' | 'backend-unreachable' | 'backend-error';
  message?: string;
}

export async function startCheckout(priceId: string): Promise<CheckoutResult> {
  if (!priceId) {
    return {
      ok: false,
      reason: 'missing-price-id',
      message:
        'Price ID not configured. Add the appropriate VITE_STRIPE_*_PRICE_ID to .env.local after creating prices in your Stripe dashboard.',
    };
  }

  const endpoint = import.meta.env.VITE_CHECKOUT_ENDPOINT || '/api/checkout';

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId }),
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

export async function startCheckoutForPlan(plan: Plan, cadence: Cadence = 'monthly'): Promise<CheckoutResult> {
  const priceId = getPriceId(plan, cadence);
  if (!priceId) {
    return {
      ok: false,
      reason: 'missing-price-id',
      message: `No price ID configured for ${plan} (${cadence}). Set VITE_STRIPE_${plan.toUpperCase()}_${cadence.toUpperCase()}_PRICE_ID in .env.local.`,
    };
  }
  return startCheckout(priceId);
}
