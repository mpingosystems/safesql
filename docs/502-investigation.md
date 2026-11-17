# safesqlpro.dev `/api/*` → bare 502: investigation (resolved)

**Status: resolved 2026-11-16.** The bare `error code: 502` on the custom domain
was never the request failing. It was the zone replacing a **502 status that our
own Function returned** with Cloudflare's own error page. `safesql.pages.dev`
passes the Function's response through unchanged; the `safesqlpro.dev` zone does
not. The earlier conclusion recorded here ("a POST whose Function makes an
outbound `fetch()` is killed at the edge") was wrong; the corrected finding and
the evidence are below.

## Corrected finding (2026-11-16, same request against both origins)

| Request | `safesqlpro.dev` | `safesql.pages.dev` |
|---|---|---|
| `POST /api/checkout` `{priceId:"price_probe_does_not_exist"}` (Stripe answers 400 → Function returns **502** JSON) | `502` `text/plain` `error code: 502`, no CORS header (4 of 4 runs) | `502` `application/json` `{"error":"Stripe API error","stripeStatus":400,...}` |
| `POST /api/validate` with a fake API key (Function makes a Supabase subrequest, returns 401) | `401` `application/json` (our JSON) | `401` `application/json` |
| `POST /api/teams/events` with a malformed JWT (Function fetches the Clerk JWKS, returns 401) | `401` `application/json` (our JSON) | `401` `application/json` |
| `POST /api/checkout` with the real Pro price ID (Stripe subrequest succeeds) | `200` `application/json`, body holds a `cs_live_` session on `checkout.stripe.com` | — |

POSTs that make outbound subrequests work on the custom domain. Only a Function
response with status **502** comes back as a bare page, and only on the custom
domain. A Cloudflare zone shows its own error page for origin 502 and 504
responses unless "origin error page pass-through" is enabled, a setting that is
Enterprise-only. `*.pages.dev` is not served through that zone, so it passes the
response through.

The original symptom (real-price checkout failing on the custom domain) fits the
same mechanism: any Stripe error made `checkout.ts` return 502, and the zone
turned that into a bare page with no JSON body and no CORS headers.

## Fix

- **Functions never return 502 or 504 from code.** Upstream failures (Stripe,
  Supabase, warehouse connections, outbound webhooks) return **503** with a JSON
  body. A static test (`cli/functionsNoGatewayStatus.test.ts`) fails if a
  502 or 504 status appears anywhere under `functions/`.
- **The cross-origin workaround is removed.** The browser used to send `/api/*`
  calls to `https://safesql.pages.dev` through a `VITE_API_BASE_URL` override.
  `apiUrl()` now always returns a relative path, so every browser call is
  same-origin and needs no CORS. A static test
  (`cli/sameOriginApi.test.ts`) fails if browser code builds an absolute
  `/api` URL.
- `/api/validate` keeps its own CORS headers for third-party browser use of the
  public REST API.

## What the workaround had hidden

Because calls went cross-origin, the CORS headers of each Function mattered.
The `/api/teams/*` helpers allowed `GET, POST, DELETE, OPTIONS` but not `PATCH`,
so cross-origin role changes and custom-rule edits failed their preflight.
Same-origin calls have no preflight, so removing the workaround fixes these too.

## Hypotheses from the first investigation (superseded)

The first investigation eliminated WAF rules, Transform and Configuration rules,
Workers routes, missing OPTIONS handlers, Node SDK use, stale bundles and
missing environment variables. It then attributed the 502 to the custom domain
terminating Functions that await a subrequest, and proposed re-binding the
custom domain or a support ticket. Neither is needed: comparing the same request
on both origins showed the 502 was our own status code, rewritten by the zone.
