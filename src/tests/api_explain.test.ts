import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 9.6-SEC Step 2: POST /api/explain. Clerk JWT verification is mocked; the
// Supabase REST plan lookup and the Anthropic call are mocked through fetch.
vi.mock('../../functions/api/_shared/clerkAuth', () => ({
  verifyClerkJWT: vi.fn(async (req: Request) => {
    const h = req.headers.get('Authorization') ?? '';
    return h === 'Bearer valid-session' ? 'user_test' : null;
  }),
}));

import { handleExplain, onRequest, EXPLAIN_UNAVAILABLE } from '../../functions/api/explain';
import type { Env } from '../../functions/_shared';

const baseEnv = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-not-real',
  CLERK_DOMAIN: 'clerk.example.test',
  ANTHROPIC_API_KEY: 'test-key-not-real',
} as unknown as Env;

const goodBody = {
  sql: 'SELECT * FROM ghost',
  issues: [{ id: 'HALLUCINATED_TABLE', title: 'Unknown table', description: 'ghost is not in the schema' }],
  schema: [{ name: 'users', columns: ['id'] }],
};

function req(body: unknown, auth: string | null = 'Bearer valid-session'): Request {
  return new Request('https://safesqlpro.dev/api/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let plan: string | null = 'pro';
let anthropic: () => Response = () =>
  new Response(JSON.stringify({ content: [{ text: '[{"id":"HALLUCINATED_TABLE","explanation":"Why.","fix":"Use users."}]' }] }));
let anthropicCalls = 0;

beforeEach(() => {
  plan = 'pro';
  anthropicCalls = 0;
  anthropic = () =>
    new Response(JSON.stringify({ content: [{ text: '[{"id":"HALLUCINATED_TABLE","explanation":"Why.","fix":"Use users."}]' }] }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/rest/v1/users?')) {
        return new Response(JSON.stringify(plan === null ? [] : [{ plan }]));
      }
      if (u.includes('api.anthropic.com')) {
        anthropicCalls++;
        return anthropic();
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/explain', () => {
  it('401 without a Clerk session, and never calls Anthropic', async () => {
    const res = await handleExplain(req(goodBody, null), baseEnv);
    expect(res.status).toBe(401);
    expect(anthropicCalls).toBe(0);
  });

  it('401 with an invalid session', async () => {
    const res = await handleExplain(req(goodBody, 'Bearer forged'), baseEnv);
    expect(res.status).toBe(401);
  });

  it('403 for a free plan, and never calls Anthropic', async () => {
    plan = 'free';
    const res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Pro/);
    expect(anthropicCalls).toBe(0);
  });

  it('403 when the user has no users row', async () => {
    plan = null;
    const res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(403);
  });

  it.each(['pro', 'team', 'business', 'enterprise'])('200 with explanations for plan %s', async (p) => {
    plan = p;
    const res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      explanations: [{ id: 'HALLUCINATED_TABLE', explanation: 'Why.', fix: 'Use users.' }],
    });
  });

  it('503 when ANTHROPIC_API_KEY is not set (entitled user)', async () => {
    const env = { ...baseEnv, ANTHROPIC_API_KEY: undefined } as unknown as Env;
    const res = await handleExplain(req(goodBody), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: EXPLAIN_UNAVAILABLE });
  });

  it('503 on upstream 429 / 5xx, without leaking the upstream body', async () => {
    anthropic = () => new Response('UPSTREAM-SECRET-DETAIL', { status: 500 });
    let res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('UPSTREAM-SECRET-DETAIL');
    anthropic = () => new Response('rate', { status: 429 });
    res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(503);
  });

  it('503 when the model reply is not a JSON array', async () => {
    anthropic = () => new Response(JSON.stringify({ content: [{ text: 'not json' }] }));
    const res = await handleExplain(req(goodBody), baseEnv);
    expect(res.status).toBe(503);
  });

  it('413 when the body exceeds 64 KB', async () => {
    const big = { ...goodBody, sql: 'SELECT 1 -- ' + 'x'.repeat(65 * 1024) };
    const res = await handleExplain(req(big), baseEnv);
    expect(res.status).toBe(413);
    expect(anthropicCalls).toBe(0);
  });

  it('400 on invalid JSON or a malformed body', async () => {
    expect((await handleExplain(req('{nope'), baseEnv)).status).toBe(400);
    expect((await handleExplain(req({ sql: 'SELECT 1', issues: [] }), baseEnv)).status).toBe(400);
    expect((await handleExplain(req({ sql: 'SELECT 1', issues: [{ id: 1 }] }), baseEnv)).status).toBe(400);
  });

  it('builds the prompt on the server: the client cannot pick model or max_tokens', async () => {
    const fetchFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await handleExplain(req({ ...goodBody, model: 'some-other-model', max_tokens: 99999 }), baseEnv);
    const call = fetchFn.mock.calls.find((c) => String(c[0]).includes('api.anthropic.com'))!;
    const sent = JSON.parse(String((call[1] as RequestInit).body));
    expect(sent.model).not.toBe('some-other-model');
    expect(sent.max_tokens).toBe(2000);
  });

  it('onRequest: OPTIONS preflight is app-origin only, and GET is 405', async () => {
    const ctx = (method: string) =>
      ({ request: new Request('https://safesqlpro.dev/api/explain', { method }), env: baseEnv });
    const pre = await onRequest(ctx('OPTIONS'));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://safesqlpro.dev');
    expect((await onRequest(ctx('GET'))).status).toBe(405);
  });
});
