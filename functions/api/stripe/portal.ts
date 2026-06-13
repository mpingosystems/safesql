import { error, json, methodNotAllowed, preflight, siteUrl, type Env } from '../../_shared';

interface PortalBody {
  // Clerk user id of the signed-in user. The customer id is looked up server-side
  // so it can't be spoofed from a stale client value.
  clerkUserId?: unknown;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  try {
    return await onRequestPost(context);
  } catch (err) {
    console.error('Portal error:', (err as Error)?.message ?? err);
    return new Response(JSON.stringify({ error: 'Billing portal unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://safesqlpro.dev' },
    });
  }
};

const onRequestPost = async ({ request, env }: Parameters<PagesFunction<Env>>[0]): Promise<Response> => {
  if (!env.STRIPE_SECRET_KEY) return error(500, 'STRIPE_SECRET_KEY not configured.');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');

  let body: PortalBody;
  try {
    body = (await request.json()) as PortalBody;
  } catch {
    return error(400, 'Invalid JSON body.');
  }
  if (typeof body.clerkUserId !== 'string' || !body.clerkUserId) {
    return error(400, 'clerkUserId is required.');
  }

  // 1. Look up the user's Stripe customer id.
  const lookup = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${encodeURIComponent(body.clerkUserId)}&select=stripe_customer_id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!lookup.ok) return error(502, 'Could not look up customer.');
  const rows = (await lookup.json()) as { stripe_customer_id?: string }[];
  const customerId = rows?.[0]?.stripe_customer_id;
  if (!customerId) return error(404, 'No Stripe customer on file for this account.');

  // 2. Create a billing portal session.
  const params = new URLSearchParams();
  params.set('customer', customerId);
  params.set('return_url', `${siteUrl(env)}/#/settings`);
  if (env.STRIPE_PORTAL_ID) params.set('configuration', env.STRIPE_PORTAL_ID);

  const idempotencyKey = crypto.randomUUID();
  // Bound the outbound call so a hung/failed api.stripe.com subrequest becomes a
  // catchable JSON error rather than a bare Cloudflare 502 (Worker killed).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-12-18.acacia',
        'Idempotency-Key': idempotencyKey,
      },
      body: params.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    return error(aborted ? 504 : 502, aborted ? 'Stripe portal timeout' : 'Stripe portal unreachable', {
      detail: aborted
        ? 'No response from api.stripe.com within 10s.'
        : ((err as Error)?.message ?? String(err)),
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const detail = await res.text();
    return error(502, 'Stripe portal error', { stripeStatus: res.status, detail });
  }
  const session = (await res.json()) as { url: string };
  return json({ url: session.url });
};
