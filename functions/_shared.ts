// Shared helpers for Cloudflare Pages Functions.
// Pages Functions auto-routes filesystem → /api/* paths.

export interface Env {
  // ── Stripe ──────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // Comma-separated Stripe price IDs per plan tier.
  // e.g. STRIPE_PRO_PRICE_IDS="price_abc,price_def"
  STRIPE_PRO_PRICE_IDS?: string;
  STRIPE_TEAM_PRICE_IDS?: string;
  STRIPE_BUSINESS_PRICE_IDS?: string;
  // Stripe Customer Portal configuration ID (uses account default if unset).
  STRIPE_PORTAL_ID?: string;
  // ── Site ────────────────────────────────────────────────────────────
  // Public origin for Stripe redirect URLs; defaults to https://safesqlpro.dev.
  SITE_URL?: string;
  // ── Supabase ─────────────────────────────────────────────────────────
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // ── Email (Resend) — all email is skipped gracefully if unset ────────
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  // ── RealityDB SimLab ─────────────────────────────────────────────────
  REALITYDB_LAB_API_BASE?: string;
  REALITYDB_LAB_API_KEY?: string;
}

// CORS for the app-origin Functions (checkout, portal, digest). Public REST
// endpoints (validate, schema/sync, badge) keep their own '*' origin.
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://safesqlpro.dev',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// 204 response for a CORS preflight (OPTIONS) request.
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': 'https://safesqlpro.dev',
      ...(init.headers ?? {}),
    },
  });
}

export function error(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, { status });
}

export function methodNotAllowed(allowed: string[]): Response {
  return new Response(`Method not allowed`, {
    status: 405,
    headers: { allow: allowed.join(', '), 'Access-Control-Allow-Origin': 'https://safesqlpro.dev' },
  });
}

export function siteUrl(env: Env): string {
  return (env.SITE_URL || 'https://safesqlpro.dev').replace(/\/+$/, '');
}
