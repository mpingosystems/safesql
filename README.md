# SafeSQL

> SQL that runs is the most dangerous SQL.

Pre-execution validation that catches semantic SQL errors before they
hit production: JOIN multiplication, missing WHERE on UPDATE/DELETE,
incomplete GROUP BY, contradictory filters, INNER JOIN on nullable
foreign keys, and more. Also the validation layer for AI-generated
SQL — 1-in-4 LLM queries has a semantic error.

**Live:** https://safesql.pages.dev (production: `safesql.dev` once DNS lands)
**Repo:** https://github.com/emkwambe/safesql

## Architecture

```
DETECTION   Deterministic AST rules (node-sql-parser)  ← never hallucinate
EXPLANATION Claude API enriches each finding           ← graceful degradation
EXECUTION   PGlite in-browser Postgres                  ← ground-truth row counts
```

The detection layer never delegates judgment to AI. Static rules with
zero-hallucination findings, AI prose only on explanation, real Postgres
for the row-count proof.

## Tech stack

- **Frontend:** React + Vite + TypeScript + Monaco editor
- **SQL parser:** node-sql-parser v5 (8 dialects)
- **AI explanations:** Anthropic Claude (`claude-sonnet-4-6`)
- **Sandbox:** `@electric-sql/pglite` (Postgres in WASM, lazy-loaded)
- **Auth:** Clerk
- **DB:** Supabase (Postgres + RLS via Clerk JWTs)
- **Backend:** Cloudflare Pages Functions
- **Payments:** Stripe Checkout
- **Hosting:** Cloudflare Pages

## Local dev

```bash
npm install
npm run dev          # Vite dev server
npm test             # vitest — 22 detector + sandbox tests
npm run build        # type-check + production build
npm run deploy       # build + wrangler pages deploy
```

## Environment variables

Build-time (`.env.local`, inlined into the JS bundle by Vite):

| Var | Required | Purpose |
|---|---|---|
| `VITE_ANTHROPIC_API_KEY` | for AI explanations | Direct browser → Anthropic. Set spending caps in Anthropic dashboard. |
| `VITE_AI_PROVIDER` | optional | Default `claude`. |
| `VITE_CLERK_PUBLISHABLE_KEY` | for auth | `pk_test_...` or `pk_live_...`. |
| `VITE_SUPABASE_URL` | for persistence | Project URL. |
| `VITE_SUPABASE_ANON_KEY` | for persistence | Anon key — RLS-protected. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | for checkout | `pk_test_...` or `pk_live_...`. |
| `VITE_STRIPE_*_PRICE_ID` (6 of them) | for checkout | Per-plan, per-cadence Stripe price IDs. |
| `VITE_CHECKOUT_ENDPOINT` | optional | Defaults to `/api/checkout`. |

Runtime, Pages env (set via `wrangler pages secret put` or dashboard — never in `.env.local` with `VITE_` prefix):

| Var | Used by |
|---|---|
| `STRIPE_SECRET_KEY` | `/api/checkout` |
| `STRIPE_WEBHOOK_SECRET` | `/api/stripe/webhook` |
| `STRIPE_{PRO,TEAM,BUSINESS}_PRICE_IDS` | `/api/stripe/webhook` (price → plan map, comma-separated) |
| `SUPABASE_URL` | webhook (REST writes via service-role) |
| `SUPABASE_SERVICE_ROLE_KEY` | webhook |
| `SITE_URL` | `/api/checkout` (Stripe success/cancel URLs). Defaults to `https://safesql.dev`. |

## Deployment

```bash
npm run deploy
```

This runs `npm run build && wrangler pages deploy dist --project-name safesql --branch main`.
Push to `main` does not auto-deploy yet — see Sprint 2 D follow-up if you
want GitHub-integrated CI builds.

## Manual setup steps

After cloning + filling `.env.local`, three things require dashboard work:

1. **Supabase:** create project, run `supabase/schema.sql` in SQL editor, link
   Clerk under Auth → Sign In/Up → Third-Party Auth (paste your Clerk Frontend
   API URL). See `supabase/README.md` for details.
2. **Stripe:** create products + prices in dashboard (Developer Tools category,
   not Education). Add a webhook endpoint at `/api/stripe/webhook` for the four
   subscription events. Then `wrangler pages secret put` the secret key,
   webhook signing secret, and the price-IDs-per-plan mapping.
3. **Clerk:** create application, enable Google + Email sign-in, copy the
   publishable key into `.env.local`.

## Layout

```
src/
├── components/         # SqlEditor, SchemaPanel, ValidationReport,
│   │                   # SandboxPanel, AuthControls, UpgradeBanner, ...
├── hooks/              # useAppUser, useSchemaLibrary
├── pages/              # Landing, Editor, Pricing
├── services/           # sqlValidator, schemaParser, sandboxRunner,
│   │                   # aiExplainer, supabaseClient, stripe,
│   │                   # persistValidation, persistSandboxRun
├── tests/              # vitest — 7-detector tests + sandbox tests
└── types/              # validation.ts (single source of truth)

functions/
├── api/
│   ├── checkout.ts            # POST → Stripe Checkout Session
│   └── stripe/webhook.ts      # Stripe webhook handler (HMAC-verified)
└── _shared.ts                 # Env, json/error helpers, siteUrl

supabase/
├── schema.sql          # canonical Postgres schema + RLS + triggers
└── README.md           # one-time Supabase + Clerk setup
```

## License

See `LICENSE`.
