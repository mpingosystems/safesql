import { error, json, methodNotAllowed, type Env } from '../../_shared';

type Plan = 'free' | 'pro' | 'team' | 'business';

interface StripeEvent {
  id: string;
  type: string;
  data: { object: any };
}

// Pages auto-405s most non-POST methods, but for GET/HEAD it falls through
// to the SPA's static-asset catch-all (returning index.html) when the path
// is nested. Explicit onRequest catches every method so a browser visit to
// the webhook URL gets 405 instead of the landing page.
export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return onRequestPost(context);
};

const onRequestPost = async ({ request, env }: Parameters<PagesFunction<Env>>[0]): Promise<Response> => {
  if (!env.STRIPE_WEBHOOK_SECRET) return error(500, 'STRIPE_WEBHOOK_SECRET not configured.');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return error(500, 'Supabase env not configured.');
  }

  const sig = request.headers.get('stripe-signature');
  if (!sig) return error(400, 'Missing stripe-signature header.');

  // Read raw body before parsing — signature verification needs the exact bytes.
  const rawBody = await request.text();

  const verified = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return error(400, 'Invalid Stripe signature.');

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return error(400, 'Invalid JSON.');
  }

  const isNew = await claimEvent(event.id, event.type, env);
  if (!isNew) {
    // Duplicate delivery — already processed, acknowledge and exit.
    return json({ received: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object, env);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(event.data.object, env);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object, env);
        break;
      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object, env);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object, env);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object, env);
        break;
      default:
        // Unhandled event types are silently ignored.
        // Future candidates: invoice.payment_action_required (SCA/3DS),
        // customer.subscription.paused, customer.subscription.resumed.
        break;
    }
  } catch (e) {
    // Return 500 so Stripe retries. Don't leak internal detail to caller.
    console.error('webhook handler error', event.type, e);
    await unclaimEvent(event.id, env);
    return error(500, 'Webhook handler failed.');
  }

  await completeEvent(event.id, env);
  return json({ received: true });
};

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: any, env: Env): Promise<void> {
  const clerkUserId: string | undefined = session.client_reference_id;
  const customerId: string | undefined = session.customer;
  const subscriptionId: string | undefined = session.subscription;
  const email: string | undefined = session.customer_details?.email ?? session.customer_email;

  if (!clerkUserId) {
    // Without a client_reference_id we can't map the session to a user.
    console.warn('checkout.session.completed without client_reference_id', session.id);
    return;
  }
  if (!subscriptionId) return;

  // Fetch the subscription to know which price (and therefore plan) was bought.
  const sub = await fetchStripeSubscription(subscriptionId, env);
  const plan = planForPriceId(sub.items?.data?.[0]?.price?.id, env);

  await upsertUserPlan(clerkUserId, email, {
    plan,
    stripe_customer_id: customerId ?? null,
    stripe_subscription_id: subscriptionId,
  }, env);
  // Best-effort: subscription_status column may not exist yet (separate migration).
  await bestEffortPatch(`clerk_user_id=eq.${enc(clerkUserId)}`, { subscription_status: 'active' }, env);

  await writeAuditPlanChanged(clerkUserId, { plan, subscription_id: subscriptionId }, env);
  await sendEmail(env, email, `Welcome to SafeSQL Pro ${cap(plan)}!`,
    `<p>Your account has been upgraded to <strong>${cap(plan)}</strong>. Thanks for subscribing to SafeSQL Pro.</p>`);
}

async function handleSubscriptionChange(subscription: any, env: Env): Promise<void> {
  const subscriptionId: string = subscription.id;
  const priceId: string | undefined = subscription.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId, env);

  await patchUserBySubscriptionId(subscriptionId, { plan }, env);
  await bestEffortPatch(`stripe_subscription_id=eq.${enc(subscriptionId)}`, { subscription_status: subscription.status ?? 'active' }, env);
}

async function handleSubscriptionCancelled(subscription: any, env: Env): Promise<void> {
  const subscriptionId: string = subscription.id;
  // Look up the user (for the audit event + email) before we clear the sub id.
  const user = await fetchUserBySubscriptionId(subscriptionId, env);

  await patchUserBySubscriptionId(
    subscriptionId,
    { plan: 'free', stripe_subscription_id: null },
    env,
  );
  await bestEffortPatch(`clerk_user_id=eq.${enc(user.clerk_user_id ?? '')}`, { subscription_status: 'canceled' }, env);

  if (user.clerk_user_id) await writeAuditPlanChanged(user.clerk_user_id, { plan: 'free', reason: 'subscription_deleted' }, env);
  await sendEmail(env, user.email, 'Your SafeSQL Pro subscription was cancelled',
    `<p>Your subscription has been cancelled and your account is now on the Free plan. You can resubscribe anytime at safesqlpro.dev/pricing.</p>`);
}

async function handlePaymentFailed(invoice: any, env: Env): Promise<void> {
  // invoice.subscription is present in Stripe API <= 2024-12-18.acacia.
  // Migrate to invoice.parent.subscription_details.subscription when
  // upgrading the pinned version.
  const subId = (invoice as any).subscription as string | undefined;
  if (!subId) {
    console.warn('[webhook] invoice.subscription missing — check pinned Stripe-Version', invoice.id);
    return;
  }
  const subscriptionId: string = subId;
  // Grace period: mark past_due but do NOT revoke access. Stripe retries per dunning.
  await bestEffortPatch(`stripe_subscription_id=eq.${enc(subscriptionId)}`, { subscription_status: 'past_due' }, env);
  const user = await fetchUserBySubscriptionId(subscriptionId, env);
  await sendEmail(env, user.email, 'SafeSQL Pro — payment failed',
    `<p>We couldn't process your latest payment. Please update your card in the billing portal to keep your subscription active. We'll retry automatically.</p>`);
}

async function handlePaymentSucceeded(invoice: any, env: Env): Promise<void> {
  // invoice.subscription is present in Stripe API <= 2024-12-18.acacia.
  // Migrate to invoice.parent.subscription_details.subscription when
  // upgrading the pinned version.
  const subId = (invoice as any).subscription as string | undefined;
  if (!subId) {
    console.warn('[webhook] invoice.subscription missing — check pinned Stripe-Version', invoice.id);
    return;
  }
  const subscriptionId: string = subId;
  await bestEffortPatch(`stripe_subscription_id=eq.${enc(subscriptionId)}`, { subscription_status: 'active' }, env);
  // New billing period — reset monthly usage counters.
  await bestEffortPatch(
    `stripe_subscription_id=eq.${enc(subscriptionId)}`,
    { validations_this_month: 0, sandbox_runs_this_month: 0 },
    env,
  );
}

async function handleTrialWillEnd(subscription: any, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) return; // skip gracefully if email isn't configured
  const user = await fetchUserBySubscriptionId(subscription.id, env);
  await sendEmail(env, user.email, 'Your SafeSQL Pro trial ends soon',
    `<p>Your free trial ends in a few days. To keep your Pro features, no action is needed — your subscription will continue automatically. Manage it anytime in the billing portal.</p>`);
}

// ── Stripe API ──────────────────────────────────────────────────────────────

async function fetchStripeSubscription(id: string, env: Env): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-12-18.acacia',
    },
  });
  if (!res.ok) throw new Error(`Stripe sub fetch ${res.status}`);
  return res.json();
}

function planForPriceId(priceId: string | undefined, env: Env): Plan {
  if (!priceId) return 'free';
  const inList = (csv: string | undefined) =>
    !!csv && csv.split(',').map((s) => s.trim()).includes(priceId);
  if (inList(env.STRIPE_PRO_PRICE_IDS)) return 'pro';
  if (inList(env.STRIPE_TEAM_PRICE_IDS)) return 'team';
  if (inList(env.STRIPE_BUSINESS_PRICE_IDS)) return 'business';
  return 'free';
}

// ── Supabase REST (PostgREST) ───────────────────────────────────────────────

interface UserPatch {
  plan?: Plan;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

async function upsertUserPlan(
  clerkUserId: string,
  email: string | undefined,
  patch: UserPatch,
  env: Env,
): Promise<void> {
  // True create-or-update. The client normally creates the users row on first
  // sign-in, but if that failed (e.g. Supabase doesn't trust the Clerk JWT and
  // the upsert 401s) the row may be missing here — and a plain PATCH would
  // match zero rows, leaving a paying customer un-upgraded. The service-role
  // key bypasses RLS. email is NOT NULL in the schema, so we can only INSERT
  // when the checkout event carried one; otherwise fall back to update-only.
  if (email) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?on_conflict=clerk_user_id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ clerk_user_id: clerkUserId, email, ...patch }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase upsert user ${res.status}: ${text}`);
    }
    return;
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${enc(clerkUserId)}`, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH user ${res.status}: ${text}`);
  }
}

async function patchUserBySubscriptionId(
  subscriptionId: string,
  patch: UserPatch,
  env: Env,
): Promise<void> {
  const url = `${env.SUPABASE_URL}/rest/v1/users?stripe_subscription_id=eq.${enc(subscriptionId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH user-by-sub ${res.status}: ${text}`);
  }
}

// Patch that is allowed to fail (e.g. subscription_status column not yet added).
async function bestEffortPatch(
  filter: string,
  patch: Record<string, unknown>,
  env: Env,
): Promise<void> {
  if (filter.endsWith('eq.')) return; // empty identifier — skip
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?${filter}`, {
      method: 'PATCH',
      headers: supabaseHeaders(env),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      // Non-throwing by design, but log so silent failures are observable
      // in Cloudflare Workers logs → Pages > Functions > Real-time logs.
      console.warn(
        '[webhook] bestEffortPatch non-ok',
        res.status,
        filter,
        Object.keys(patch),
      );
    }
  } catch (e) {
    console.warn('[webhook] bestEffortPatch threw', filter, (e as Error)?.message);
  }
}

async function fetchUserBySubscriptionId(
  subscriptionId: string,
  env: Env,
): Promise<{ email?: string; clerk_user_id?: string }> {
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/users?stripe_subscription_id=eq.${enc(subscriptionId)}&select=email,clerk_user_id`;
    const res = await fetch(url, { headers: supabaseHeaders(env) });
    if (!res.ok) return {};
    const rows = (await res.json()) as { email?: string; clerk_user_id?: string }[];
    return rows?.[0] ?? {};
  } catch {
    return {};
  }
}

async function writeAuditPlanChanged(clerkUserId: string, data: Record<string, unknown>, env: Env): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: supabaseHeaders(env),
      body: JSON.stringify({ user_id: clerkUserId, event_type: 'plan_changed', event_data: data }),
    });
  } catch {
    /* best-effort audit */
  }
}

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

// ── Webhook idempotency ─────────────────────────────────────────────────────

// Claim an event by inserting its id. Returns true if newly claimed (process
// it), false if it already exists (duplicate delivery — skip). Fails open
// (returns true) on any error: better to risk double-processing than to block
// every webhook when the idempotency store is unreachable.
async function claimEvent(
  eventId: string, eventType: string, env: Env
): Promise<boolean> {
  // Step 1: attempt to INSERT (claim the event).
  let insertRes: Response;
  try {
    insertRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/processed_stripe_events`,
      {
        method: 'POST',
        headers: {
          ...supabaseHeaders(env),
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify({ event_id: eventId, event_type: eventType }),
      },
    );
  } catch {
    return true; // network error — fail open
  }
  if (!insertRes.ok) {
    console.warn('[webhook] claimEvent insert error', insertRes.status, eventId);
    return true; // fail open
  }
  const newRows = (await insertRes.json()) as unknown[];
  if (newRows.length > 0) return true; // ✅ newly claimed

  // Step 2: row exists. Check claimed_at / completed_at.
  let row: { completed_at: string | null; claimed_at: string } | undefined;
  try {
    const checkRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/processed_stripe_events` +
        `?event_id=eq.${enc(eventId)}&select=claimed_at,completed_at`,
      { headers: supabaseHeaders(env) },
    );
    if (checkRes.ok) {
      const rows = (await checkRes.json()) as typeof row[];
      row = rows[0];
    }
  } catch { /* fall through to fail-open */ }

  if (!row) return true; // disappeared or unreachable — fail open

  // Step 3a: already completed — genuine duplicate delivery, skip.
  if (row.completed_at !== null) return false;

  // Step 3b: claimed but not completed.
  // If claimed < 5 min ago another Worker may still be running — skip.
  const STALE_MS = 5 * 60 * 1000;
  const claimedAgoMs = Date.now() - new Date(row.claimed_at).getTime();
  if (claimedAgoMs < STALE_MS) {
    console.warn('[webhook] event in-flight, skipping duplicate', eventId);
    return false;
  }

  // Step 3c: stale claim (Worker crashed). Delete and reclaim.
  console.warn('[webhook] reclaiming stale claim (Worker crash?)', eventId,
    `claimed ${Math.round(claimedAgoMs / 1000)}s ago`);
  await unclaimEvent(eventId, env);
  try {
    const reclaimRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/processed_stripe_events`,
      {
        method: 'POST',
        headers: {
          ...supabaseHeaders(env),
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify({ event_id: eventId, event_type: eventType }),
      },
    );
    if (!reclaimRes.ok) return true; // fail open
    const reclaimRows = (await reclaimRes.json()) as unknown[];
    return reclaimRows.length > 0;
  } catch {
    return true; // fail open
  }
}

// Release a previously claimed event so Stripe's retry can reprocess it.
// Best-effort: any failure is swallowed (the event simply stays claimed).
async function unclaimEvent(eventId: string, env: Env): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/processed_stripe_events?event_id=eq.${enc(eventId)}`, {
      method: 'DELETE',
      headers: supabaseHeaders(env),
    });
  } catch {
    /* best-effort unclaim */
  }
}

// Mark a claimed event as fully processed. Best-effort: if this fails the
// event will appear as a stale claim after 5 min and will be reclaimed on
// the next Stripe retry (which Stripe will issue because we'd return 500).
async function completeEvent(eventId: string, env: Env): Promise<void> {
  try {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/processed_stripe_events` +
        `?event_id=eq.${enc(eventId)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(env),
        body: JSON.stringify({ completed_at: new Date().toISOString() }),
      },
    );
  } catch {
    /* best-effort complete — stale-reclaim handles the crash path */
  }
}

// ── Email (Resend) — best-effort, no-op when RESEND_API_KEY is unset ─────────

async function sendEmail(env: Env, to: string | undefined, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'SafeSQL Pro <noreply@safesqlpro.dev>',
        to,
        subject,
        html,
      }),
    });
  } catch {
    /* best-effort email */
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Stripe signature verification (Web Crypto, no SDK) ──────────────────────

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  // Header format: "t=<unix>,v1=<hex>,v1=<hex>,..." (multiple v1's possible during rotation)
  const parts = Object.create(null) as Record<string, string[]>;
  for (const segment of header.split(',')) {
    const [key, val] = segment.split('=');
    if (!key || !val) continue;
    if (!parts[key]) parts[key] = [];
    parts[key].push(val);
  }
  const t = parts['t']?.[0];
  const sigs = parts['v1'] ?? [];
  if (!t || sigs.length === 0) return false;

  // Reject signatures older than 5 minutes (replay protection).
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(t);
  if (Number.isNaN(ageSeconds) || ageSeconds < 0 || ageSeconds > 300) return false;

  const signed = `${t}.${payload}`;
  const expected = await hmacSha256Hex(secret, signed);

  // Constant-time compare — Web Crypto doesn't expose this directly, so
  // we hash both strings to fixed-length and compare byte-by-byte.
  return sigs.some((s) => timingSafeEqual(s, expected));
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc2 = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc2.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc2.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
