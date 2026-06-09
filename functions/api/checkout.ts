import { error, json, methodNotAllowed, type Env, siteUrl } from '../_shared';

interface CheckoutBody {
  priceId?: unknown;
  // Optional — if present, ties the Checkout Session to a specific user
  // so the webhook can identify them. Sprint 2 B-phase will populate this
  // with the Clerk user ID once auth is wired up.
  clientReferenceId?: unknown;
  // Optional — pre-fills email on Stripe's hosted checkout.
  customerEmail?: unknown;
}

// onRequest catches every method so non-POST requests land on a clean
// 405 instead of falling through to the SPA's static-asset catch-all.
export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return onRequestPost(context);
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

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
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
