# SafeSQL — Supabase setup

One-time setup for the persistence layer. Takes ~10 minutes.

## 1. Create the project

1. Sign up at https://supabase.com
2. Create a new project (any region; US East matches your other infra)
3. Note the project URL (`https://<ref>.supabase.co`) and the **anon** + **service_role** keys from **Project Settings → API**

## 2. Run the schema

Open **SQL Editor** in the Supabase dashboard, paste the contents of `schema.sql`, and run it.

This creates `users`, `schemas`, `validations`, `sandboxes` plus RLS policies that read the Clerk user ID from `auth.jwt() ->> 'sub'`.

## 3. Wire Clerk as a third-party auth provider

This is what makes RLS work with Clerk's JWTs.

1. **Authentication → Sign In / Up → Third Party Auth**
2. Click **Add provider** → **Clerk**
3. Paste your Clerk Frontend API URL (looks like `https://<your-app>.clerk.accounts.dev`)
4. Save

Behind the scenes Supabase fetches Clerk's JWKS and trusts incoming JWTs signed by it. From Postgres' point of view, `auth.jwt() ->> 'sub'` now equals the Clerk user ID.

## 4. Set env vars

### Local dev (`.env.local`)

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

### Cloudflare Pages (Settings → Variables and secrets → Production, encrypted)

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # NEVER in .env.local with VITE_ prefix
```

The service-role key bypasses RLS — used only by `functions/api/stripe/webhook.ts` to update the `users` table from Stripe events.

## 5. Verify

Once the frontend has the anon key + Clerk publishable key:

1. Sign in via Clerk on the deployed site
2. In Supabase **Authentication → Users**, you should NOT see a Supabase-side user (Clerk owns identity)
3. Validation history (Sprint 2 B3) writes will appear in the `validations` table, scoped by Clerk user via RLS

If RLS blocks reads when you expect them to succeed, check that:
- The Clerk JWT carries a `sub` claim (default — no template needed)
- Supabase's third-party auth provider config trusts your Clerk instance
- A row in `users` exists for the signed-in `clerk_user_id` (B3 creates it on first sign-in)
