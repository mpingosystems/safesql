import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 9.6-REL: POST /api/checkout status mapping. The live smoke check
// (scripts/smoke.mjs) only probes the malformed-priceId 400 path so it never
// calls Stripe; the upstream 503 mapping is covered here with a mocked fetch.

import { onRequest } from '../../functions/api/checkout';
import type { Env } from '../../functions/_shared';

const env = { STRIPE_SECRET_KEY: 'sk_test_not_real', SITE_URL: 'https://safesqlpro.dev' } as unknown as Env;

function call(body: unknown, e: Env = env, method = 'POST') {
  const request = new Request('https://safesqlpro.dev/api/checkout', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return onRequest({ request, env: e });
}

let stripe: () => Promise<Response>;
let stripeCalls = 0;

beforeEach(() => {
  stripeCalls = 0;
  stripe = async () => new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!String(url).startsWith('https://api.stripe.com/')) throw new Error(`unexpected fetch ${url}`);
      stripeCalls++;
      return stripe();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/checkout', () => {
  it('malformed priceId -> 400 JSON without calling Stripe (the smoke-check probe)', async () => {
    const res = await call({ priceId: 'not-a-price' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(stripeCalls).toBe(0);
  });

  it('invalid JSON -> 400 without calling Stripe', async () => {
    const res = await call('{not json');
    expect(res.status).toBe(400);
    expect(stripeCalls).toBe(0);
  });

  it('Stripe rejects the price -> 503 JSON, never 502', async () => {
    stripe = async () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400 });
    const res = await call({ priceId: 'price_does_not_exist' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(((await res.json()) as { stripeStatus: number }).stripeStatus).toBe(400);
    expect(stripeCalls).toBe(1);
  });

  it('Stripe unreachable -> 503 JSON', async () => {
    stripe = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await call({ priceId: 'price_x' });
    expect(res.status).toBe(503);
  });

  it('Stripe 5xx -> 503, not passed through', async () => {
    stripe = async () => new Response('upstream', { status: 502 });
    const res = await call({ priceId: 'price_x' });
    expect(res.status).toBe(503);
  });

  it('valid price -> 200 with the session URL', async () => {
    const res = await call({ priceId: 'price_ok' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it('no Stripe key -> 500 JSON', async () => {
    const res = await call({ priceId: 'price_ok' }, {} as Env);
    expect(res.status).toBe(500);
    expect(stripeCalls).toBe(0);
  });

  it('GET -> 405', async () => {
    const res = await call(undefined, env, 'GET');
    expect(res.status).toBe(405);
  });
});
