// Sprint 10 — Stripe live-mode price IDs, sourced from Vite env (set in Cloudflare
// Pages). The shorter names below are what stripe-setup.ps1 writes; the legacy
// VITE_STRIPE_*_PRICE_ID names are kept as a fallback so older deployments keep
// working without a redeploy.
export const STRIPE_PRICES = {
  pro: {
    monthly: import.meta.env.VITE_STRIPE_PRO_MONTHLY ?? import.meta.env.VITE_STRIPE_PRO_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_PRO_ANNUAL ?? import.meta.env.VITE_STRIPE_PRO_ANNUAL_PRICE_ID,
  },
  team: {
    monthly: import.meta.env.VITE_STRIPE_TEAM_MONTHLY ?? import.meta.env.VITE_STRIPE_TEAM_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_TEAM_ANNUAL ?? import.meta.env.VITE_STRIPE_TEAM_ANNUAL_PRICE_ID,
  },
  business: {
    monthly: import.meta.env.VITE_STRIPE_BUSINESS_MONTHLY ?? import.meta.env.VITE_STRIPE_BUSINESS_MONTHLY_PRICE_ID,
    annual: import.meta.env.VITE_STRIPE_BUSINESS_ANNUAL ?? import.meta.env.VITE_STRIPE_BUSINESS_ANNUAL_PRICE_ID,
  },
} as const;

export const STRIPE_PORTAL_ID = import.meta.env.VITE_STRIPE_PORTAL_ID as string | undefined;
