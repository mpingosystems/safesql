# safesqlpro.dev POST `/api/*` → 502 — Investigation

Custom-domain `safesqlpro.dev` returns a **bare Cloudflare 502** for some POSTs to
Pages Functions, while the **canonical `safesql.pages.dev` works identically**.
Active workaround: `VITE_API_BASE_URL=https://safesql.pages.dev` routes checkout /
portal at the canonical origin. **Do not remove the workaround until fixed.**

## Exact behaviour (measured)

| Request | `safesqlpro.dev` | `safesql.pages.dev` |
|---|---|---|
| `OPTIONS /api/checkout` | **204** (our preflight) | 204 |
| `GET /api/checkout` | **405** (our `methodNotAllowed`) | 405 |
| `POST /api/checkout` `{priceId:"INVALID"}` (400 **before** any outbound fetch) | **200/400 — our JSON** ✓ | our JSON |
| `POST /api/stripe/webhook` no-signature (400 **before** any outbound fetch) | **our JSON 400** ✓ | our JSON 400 |
| `POST /api/checkout` `{priceId:"price_…"}` (→ Worker fetches `api.stripe.com`) | **`error code: 502`** (text/plain, no CORS header) ✗ | our JSON / `cs_live_…` ✓ |

**Decisive finding:** the split is **not** by HTTP method. A POST that returns
*without making an outbound subrequest* works on `safesqlpro.dev`; a POST whose
Function makes an **outbound `fetch()`** (to `api.stripe.com` / Supabase) is killed
at the edge → bare 502. The identical outbound call succeeds on `pages.dev`.

Our handler wraps the fetch in `try/catch` + a 10s `AbortController`; neither fires —
the request is terminated by the edge **before** the Function can return. So this is
a property of how `safesqlpro.dev`'s custom-domain path handles a Function that
awaits a subrequest, independent of method, body, or our code.

## Eliminated hypotheses (with evidence)

- **WAF / firewall rules** — confirmed empty; and a no-outbound POST works, so no
  method/path block.
- **Transform / Configuration rules** — confirmed empty.
- **Worker routes on the zone** — `wrangler … workers_list` → **0 Workers**; nothing
  intercepts `/api/*`.
- **CORS / missing OPTIONS** — OPTIONS returns 204; same-origin POST never preflights;
  adding CORS/OPTIONS handlers did not change the 502.
- **Node SDK / Buffer** — no `stripe-node`; functions are raw `fetch` + Web Crypto.
- **Stale bundle / wrong price IDs** — reproduced with `curl` against current deploy;
  `pages.dev` returns `cs_live_…` for the same request.
- **Missing env vars** — `STRIPE_SECRET_KEY` valid (Stripe authenticates on pages.dev).
- **`_headers` / `_redirects` / `_routes.json`** — reviewed: cache rules only; the
  only redirect is a host-qualified 301 from `safesql.realitydb.dev` (does not touch
  `safesqlpro.dev`); `_routes.json` correctly `include: ["/api/*"]`. No wrangler.toml.

## Remaining hypotheses (need Cloudflare-side inspection)

1. **Custom-domain attachment / routing** — `safesqlpro.dev` may route the Function
   through an extra hop (Cloudflare-for-SaaS custom hostname, or a proxied CNAME)
   that can't complete a Worker subrequest. Re-adding the custom domain in Pages →
   Custom domains may force a clean re-bind.
2. **A short edge/origin timeout** on the zone that aborts the Function once it awaits
   a subrequest (sub-second), while `pages.dev` uses the default.
3. A zone-level setting not surfaced in WAF/Rules (e.g. an account/zone-specific
   subrequest restriction).

## Recommended next step

**Open a Cloudflare support ticket** with this exact symptom:

> Pages project `safesql`. On the custom domain `safesqlpro.dev`, POST to a Pages
> Function that makes an outbound `fetch()` returns a bare `error code: 502`
> (Server: cloudflare, text/plain), while the same request on
> `<project>.pages.dev` succeeds. POSTs that return without an outbound subrequest
> work on the custom domain. OPTIONS/GET work. WAF, Transform/Config Rules, and
> Worker Routes are all empty; there are no Workers on the account. Need to know why
> the custom-domain path terminates a Function's subrequest.

Until resolved, the `pages.dev` workaround keeps checkout/portal/webhook working.
