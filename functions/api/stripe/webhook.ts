import { error, json, methodNotAllowed, type Env } from '../../_shared';

interface WebhookEnv extends Env {
  // Comma-separated price IDs that map to each plan. Set in Pages env.
  // e.g. STRIPE_PRO_PRICE_IDS="price_1Q...monthly,price_1Q...annual"
  STRIPE_PRO_PRICE_IDS?: string;
  STRIPE_TEAM_PRICE_IDS?: string;
  STRIPE_BUSINESS_PRICE_IDS?: string;
}

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
export const onRequest: PagesFunction<WebhookEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return onRequestPost(context);
};

const onRequestPost = async ({ request, env }: Parameters<PagesFunction<WebhookEnv>>[0]): Promise<Response> => {
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
      case 'invoice.payment_failed':
        // Sprint 2 follow-up: queue notification. For now, log and continue —
        // Stripe will retry per its dunning schedule.
        console.log('payment_failed for customer', event.data.object?.customer);
        break;
      default:
        // Ignore unknown event types — Stripe sends many we don't care about.
        break;
    }
  } catch (e) {
    // Return 500 so Stripe retries. Don't leak internal detail to caller.
    console.error('webhook handler error', event.type, e);
    return error(500, 'Webhook handler failed.');
  }

  return json({ received: true });
};

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: any, env: WebhookEnv): Promise<void> {
  const clerkUserId: string | undefined = session.client_reference_id;
  const customerId: string | undefined = session.customer;
  const subscriptionId: string | undefined = session.subscription;

  if (!clerkUserId) {
    // Without a client_reference_id we can't map the session to a user.
    // The frontend should always include one once auth is wired (Sprint 2 B1).
    console.warn('checkout.session.completed without client_reference_id', session.id);
    return;
  }
  if (!subscriptionId) return;

  // Fetch the subscription to know which price (and therefore plan) was bought.
  const sub = await fetchStripeSubscription(subscriptionId, env);
  const plan = planForPriceId(sub.items?.data?.[0]?.price?.id, env);

  await upsertUserPlan(clerkUserId, {
    plan,
    stripe_customer_id: customerId ?? null,
    stripe_subscription_id: subscriptionId,
  }, env);
}

async function handleSubscriptionChange(subscription: any, env: WebhookEnv): Promise<void> {
  const subscriptionId: string = subscription.id;
  const priceId: string | undefined = subscription.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId, env);

  await patchUserBySubscriptionId(subscriptionId, { plan }, env);
}

async function handleSubscriptionCancelled(subscription: any, env: WebhookEnv): Promise<void> {
  const subscriptionId: string = subscription.id;
  await patchUserBySubscriptionId(
    subscriptionId,
    { plan: 'free', stripe_subscription_id: null },
    env,
  );
}

// ── Stripe API ──────────────────────────────────────────────────────────────

async function fetchStripeSubscription(id: string, env: Env): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe sub fetch ${res.status}`);
  return res.json();
}

function planForPriceId(priceId: string | undefined, env: WebhookEnv): Plan {
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

async function upsertUserPlan(clerkUserId: string, patch: UserPatch, env: Env): Promise<void> {
  // PATCH the row matching this Clerk user. If the user doesn't exist yet,
  // do nothing — they'll be created on first sign-in by the frontend.
  const url = `${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${encodeURIComponent(clerkUserId)}`;
  const res = await fetch(url, {
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
  const url = `${env.SUPABASE_URL}/rest/v1/users?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`;
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

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
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
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
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
