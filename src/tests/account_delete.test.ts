import { describe, it, expect, vi, afterEach } from 'vitest';
import { performAccountDeletion, handleDelete } from '../../functions/api/account/delete';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  STRIPE_SECRET_KEY: 'sk_test',
  CLERK_SECRET_KEY: 'csk',
  CLERK_DOMAIN: 'clerk.safesqlpro.dev',
} as unknown as Parameters<typeof performAccountDeletion>[1];

function reqNoAuth(): Request {
  return { headers: { get: () => null }, json: async () => ({}) } as unknown as Request;
}

let calls: { url: string; method: string }[] = [];

function mockFetch(hasSub = true) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (u.includes('/rest/v1/users?') && method === 'GET') {
        return {
          ok: true,
          json: async () => [{ id: 'uuid1', email: 'a@b.com', stripe_subscription_id: hasSub ? 'sub_1' : null }],
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('account delete', () => {
  it('returns 401 without a JWT', async () => {
    mockFetch();
    const res = await handleDelete(reqNoAuth(), env);
    expect(res.status).toBe(401);
  });

  it('cancels Stripe before any Supabase delete, and deletes the Clerk user last', async () => {
    mockFetch();
    const result = await performAccountDeletion('user_x', env, 'no longer needed');
    expect(result.ok).toBe(true);

    const idx = (pred: (c: { url: string; method: string }) => boolean) => calls.findIndex(pred);
    const stripeCancel = idx((c) => c.url.includes('api.stripe.com/v1/subscriptions/') && c.method === 'DELETE');
    const firstDataDelete = idx((c) => c.url.includes('/rest/v1/') && c.method === 'DELETE');
    const usersDelete = idx((c) => c.url.includes('/rest/v1/users?') && c.method === 'DELETE');
    const clerkDelete = idx((c) => c.url.includes('api.clerk.com/v1/users/') && c.method === 'DELETE');

    expect(stripeCancel).toBeGreaterThanOrEqual(0);
    expect(clerkDelete).toBeGreaterThanOrEqual(0);
    expect(stripeCancel).toBeLessThan(firstDataDelete); // Stripe cancel before data deletion
    expect(stripeCancel).toBeLessThan(usersDelete);
    expect(clerkDelete).toBe(calls.length - 1); // Clerk delete is the final call
  });

  it('aborts before the Clerk delete when a Supabase delete fails', async () => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        calls.push({ url: u, method });
        if (u.includes('/rest/v1/users?') && method === 'GET') {
          return { ok: true, json: async () => [{ id: 'u', email: 'a@b.com', stripe_subscription_id: null }] } as unknown as Response;
        }
        if (u.includes('/rest/v1/') && method === 'DELETE') {
          return { ok: false, text: async () => 'boom' } as unknown as Response;
        }
        return { ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
      }),
    );
    const result = await performAccountDeletion('user_x', env);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(calls.some((c) => c.url.includes('api.clerk.com'))).toBe(false); // Clerk never touched
  });
});
