# SafeSQL Pro — Stripe + Infra Deploy Runbook

> **Every production deploy must complete the applicable pre-deploy steps
> before pushing, and all post-deploy smoke tests before closing the ticket.**

---

## Migration strategy — processed_stripe_events

| Environment state | Action |
|---|---|
| Fresh DB (20260612120000 never applied) | Apply `20260612120000` only |
| 20260612120000 already applied with old `processed_at` schema | Apply `20260612120001` only |
| Both already applied in sequence | No-op — already correct |

---

## PRE-DEPLOY

### Step 1 — Supabase: apply migration

Open **Supabase Dashboard → SQL Editor**.

**Fresh environment:** paste and run:

```
supabase/migrations/20260612120000_processed_stripe_events.sql
```

**Existing environment with old `processed_at` schema:** paste and run:

```
supabase/migrations/20260612120001_pse_add_completed_at.sql
```

Verify the table exists with the correct columns:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'processed_stripe_events'
ORDER BY ordinal_position;
```
Expected columns: `event_id`, `event_type`, `claimed_at`, `completed_at`

---

### Step 2 — Cloudflare Pages: audit env vars

**Pages → safesql project → Settings → Environment variables**

Confirm every variable is set for the **Production** environment:

**Required — will 500 if missing:**

| Variable | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Use the current live key (`sk_live_...`) after any rotation |
| `STRIPE_WEBHOOK_SECRET` | Must match the signing secret shown in Stripe Dashboard for the endpoint |
| `SUPABASE_URL` | |
| `SUPABASE_SERVICE_ROLE_KEY` | |

**Required for plan mapping — webhook silently maps all plans to `free` if missing:**

| Variable | Format |
|---|---|
| `STRIPE_PRO_PRICE_IDS` | Comma-separated, e.g. `price_abc,price_def` |
| `STRIPE_TEAM_PRICE_IDS` | Comma-separated |
| `STRIPE_BUSINESS_PRICE_IDS` | Comma-separated |

**Optional — features degrade gracefully if absent:**

| Variable | Fallback behaviour |
|---|---|
| `STRIPE_PORTAL_ID` | Uses Stripe account default portal config |
| `SITE_URL` | Defaults to `https://safesqlpro.dev` |
| `RESEND_API_KEY` | All transactional email silently skipped |
| `RESEND_FROM` | Defaults to `SafeSQL Pro <noreply@safesqlpro.dev>` |

After any env var change, **trigger a manual redeploy** — Pages does not
hot-reload env vars into active Workers.

---

### Step 3 — Stripe Dashboard: verify webhook endpoint

**Developers → Webhooks → `https://safesqlpro.dev/api/stripe/webhook`**

**3a. Subscribed events** — confirm all seven are enabled:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `invoice.payment_failed`
- `invoice.payment_succeeded`

If the endpoint does not exist: **Add endpoint** → paste URL → select the
events above → **Save** → copy the Signing secret → paste into
`STRIPE_WEBHOOK_SECRET` in Cloudflare Pages env vars.

**3b. Endpoint API version — critical** ⚠️

Click the endpoint → locate the **API version** dropdown (top-right of the
endpoint detail page).

Set to: **`2024-12-18.acacia`**

> **Why this matters:** The `Stripe-Version` header in Workers code controls
> the API version for *outbound* requests only (fetching subscriptions,
> creating sessions). *Inbound* webhook payloads are rendered at the
> endpoint's own pinned version — a separate setting.
>
> If the endpoint version is `≥ 2025-01-27.acacia`:
> - `invoice.payment_failed` → `invoice.subscription` is `undefined` →
>   guard fires → handler no-ops → `past_due` never set, dunning email
>   never sent
> - `invoice.payment_succeeded` → same → usage counters never reset
>
> Pinning both to `2024-12-18.acacia` keeps inbound payload shape in sync
> with handler expectations. When upgrading the pinned version in code,
> update this endpoint setting at the same time.

---

### Step 4 — Clerk DNS (first deploy only)

Add a CNAME record in **Cloudflare DNS → safesqlpro.dev**:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `clerk` |
| Target | `frontend-api.clerk.services` |
| Proxy status | **DNS only** (grey cloud — must NOT be proxied) |
| TTL | Auto |

Verify propagation:
```bash
nslookup clerk.safesqlpro.dev 1.1.1.1
```
Should resolve within 1–5 minutes.

---

## POST-DEPLOY

### Step 5 — Confirm Cloudflare build succeeded

**Pages → Deployments** — latest commit shows **Success**.

If the build fails, check the build log before proceeding.

---

### Step 6 — Smoke test: `/api/checkout`

```bash
curl -s -X POST https://safesqlpro.dev/api/checkout \
  -H "Content-Type: application/json" \
  -d '{"priceId":"price_YOUR_TEST_PRICE_ID"}' | jq .
```

**Expected:**
```json
{ "url": "https://checkout.stripe.com/...", "sessionId": "cs_..." }
```

**Still getting 502?** → Wrong `STRIPE_SECRET_KEY` in Pages env vars (key
was rotated but the old value is still set). Update and redeploy.

---

### Step 7 — Smoke test: Clerk bundle loads

Open `https://safesqlpro.dev` → **DevTools → Network tab**.

Filter by: `clerk.safesqlpro.dev`

Expected: `clerk.browser.js` returns **200** (not `ERR_NAME_NOT_RESOLVED`).

If still failing → CNAME not propagated yet, or proxy is ON (must be OFF).

---

### Step 8 — Stripe CLI: replay each event type

```bash
stripe listen --forward-to https://safesqlpro.dev/api/stripe/webhook
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.payment_succeeded
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.deleted
```

For each event, check **Pages → Functions → Real-time Logs**. You should see:

- ✅ No `[webhook] bestEffortPatch non-ok` warnings
- ✅ No `[webhook] invoice.subscription missing` warnings
- ✅ A row inserted in `processed_stripe_events` with `completed_at` populated

---

### Step 9 — Idempotency test: replay the same event twice

```bash
# Copy any evt_... ID from Stripe Dashboard → Events
stripe events resend evt_XXXXXXXXXXXX
stripe events resend evt_XXXXXXXXXXXX   # same ID, immediately
```

**Expected:**
- Second delivery logs nothing and returns `{ "received": true }`
- `processed_stripe_events` contains exactly **one row** for that `event_id`

---

### Step 10 — Workers logs: baseline check

**Pages → Functions → Real-time Logs** — trigger a checkout and watch for
5 minutes. No unexpected errors should appear.

---

## Notes

- **Stripe API version pinned to `2024-12-18.acacia`** in all Workers
  fetch calls. When upgrading: update the `Stripe-Version` header in
  `checkout.ts`, `portal.ts`, `webhook.ts`, AND the endpoint API version
  in the Stripe Dashboard (Step 3b) simultaneously.
- **Stale-claim window:** 5 minutes. A webhook event claimed but not
  completed within 5 min (crashed Worker) is eligible for reclaim on
  the next Stripe retry. No action needed; handled automatically.
- **bestEffortPatch failures** surface as `console.warn` in Workers logs,
  not errors. They indicate a missing column or network blip — check
  Real-time Logs if `subscription_status` is unexpectedly stale.
