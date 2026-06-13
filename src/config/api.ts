// Base origin for first-party /api/* calls.
//
// Defaults to the current origin (same-origin, relative behaviour). Set
// VITE_API_BASE_URL to route calls through a different origin — currently the
// canonical https://safesql.pages.dev deployment, where POST /api/* works while
// the safesqlpro.dev custom-domain edge returns a bare 502 on POST (an edge-rule
// issue tracked in realitydb-internal/05-safesql/CHECKOUT-502-HANDOFF.md).
//
// Cross-origin use requires the target Function to send CORS headers + handle
// OPTIONS. Only route endpoints that do (checkout, portal, digest, validate,
// schema/sync, badge) — NOT schema/connections or webhook/notify, which lack them.
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (typeof window !== 'undefined' ? window.location.origin : '');

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}`;
}
