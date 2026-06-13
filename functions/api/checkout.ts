import { error, json, methodNotAllowed, type Env, siteUrl } from '../_shared';

interface CheckoutBody {
  priceId?: unknown;
  clientReferenceId?: unknown;
  customerEmail?: unknown;
}

// onRequest catches every method so non-POST requests land on a clean
// 405 instead of falling through to the SPA's static-asset catch-all.
// The try/catch turns any unexpected Worker crash (which Cloudflare would
// surface as a raw 502) into a readable 500 that shows up in Functions logs.
export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  try {
    return await onRequestPost(context);
  } catch (err) {
    console.error('Checkout error:', (err as Error)?.message ?? err);
    return new Response(JSON.stringify({ error: 'Checkout unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

const onRequestPost = async (context: Parameters<PagesFunction<Env>>[0]): Promise<Response> => {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) {
    return error(500, 'STRIPE_SECRET_KEY not configured on this deployment.');
  }

  let body: CheckoutBody;
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return error(400, 'Invalid JSON body.');
  }

  const { priceId } = body;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    return error(400, 'priceId must be a Stripe price ID (price_...).');
  }

  const base = siteUrl(env);
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  // Hash-routed SPA: the route is read from the URL hash, so land on
  // #/settings (success banner reads ?checkout=success from the hash query).
  params.set('success_url', `${base}/#/settings?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${base}/#/pricing`);
  params.set('allow_promotion_codes', 'true');
  params.set('billing_address_collection', 'auto');

  if (typeof body.clientReferenceId === 'string' && body.clientReferenceId) {
    params.set('client_reference_id', body.clientReferenceId);
  }
  if (typeof body.customerEmail === 'string' && body.customerEmail) {
    params.set('customer_email', body.customerEmail);
  }

  if (typeof body.clientReferenceId === 'string' && body.clientReferenceId) {
    params.set('subscription_data[metadata][clerk_user_id]', body.clientReferenceId);
  }
  params.set('subscription_data[metadata][site]', 'safesqlpro.dev');

  const idempotencyKey = crypto.randomUUID();
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-12-18.acacia',
      'Idempotency-Key': idempotencyKey,
    },
    body: params.toString(),
  });

  if (!stripeRes.ok) {
    const detail = await stripeRes.text();
    return error(502, 'Stripe API error', { stripeStatus: stripeRes.status, detail });
  }

  const session = (await stripeRes.json()) as { id: string; url: string };
  return json({ url: session.url, sessionId: session.id });
};
