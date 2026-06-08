// Canonical site URL. safesql.dev is the primary domain (Sprint 7);
// safesql.realitydb.dev 301-redirects to it. Override per-environment with
// VITE_SITE_URL (e.g. http://localhost:5173 in dev).
export const SITE_URL =
  (import.meta.env.VITE_SITE_URL as string | undefined) ?? 'https://safesql.dev';

export const CANONICAL_DOMAIN = 'safesql.dev';
