// Shared helpers for Cloudflare Pages Functions.
// Pages Functions auto-routes filesystem → /api/* paths.

export interface Env {
  // Stripe — set in Pages dashboard > Settings > Environment variables (encrypted).
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Public URL of the deployed site, used for Stripe success/cancel URLs.
  // Defaults to https://safesql.dev when unset.
  SITE_URL?: string;

  // Supabase — service-role key bypasses RLS (only for trusted server code).
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // RealityDB SimLab — for /api/sandbox sandbox execution.
  REALITYDB_LAB_API_BASE?: string;
  REALITYDB_LAB_API_KEY?: string;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function error(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, { status });
}

export function methodNotAllowed(allowed: string[]): Response {
  return new Response(`Method not allowed`, {
    status: 405,
    headers: { allow: allowed.join(', ') },
  });
}

export function siteUrl(env: Env): string {
  return (env.SITE_URL || 'https://safesql.dev').replace(/\/+$/, '');
}
