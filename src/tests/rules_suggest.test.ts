import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 9.6-SEC Step 1: /api/rules/suggest on the shared Anthropic helper. These are
// the endpoint's first tests. Intentional behavior change (owner decision): any
// AI failure is now a 503 with no upstream detail (was 500 for a missing key and
// 502 + raw upstream body otherwise).

let keyRow: { plan: string; revoked_at: string | null } | null = { plan: 'pro', revoked_at: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: keyRow, error: null }) }),
      }),
    }),
  }),
}));

import { handleSuggest, SUGGEST_UNAVAILABLE } from '../../functions/api/rules/suggest';
import type { Env } from '../../functions/_shared';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-not-real',
  ANTHROPIC_API_KEY: 'test-key-not-real',
} as unknown as Env;

const RULE_JSON = JSON.stringify({
  rule_type: 'forbidden_table',
  name: 'No raw PII',
  description: 'Never query raw_pii',
  config: { table: 'raw_pii', message: 'Use the masked view.' },
  severity: 'error',
});

let upstream: () => Response;

function req(body: unknown, auth: string | null = 'Bearer test-api-key'): Request {
  return new Request('https://safesqlpro.dev/api/rules/suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  keyRow = { plan: 'pro', revoked_at: null };
  upstream = () => new Response(JSON.stringify({ content: [{ text: RULE_JSON }] }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => upstream()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/rules/suggest', () => {
  it('401 without an API key', async () => {
    expect((await handleSuggest(req({ description: 'x' }, null), env)).status).toBe(401);
  });

  it('401 for an unknown or revoked key', async () => {
    keyRow = null;
    expect((await handleSuggest(req({ description: 'x' }), env)).status).toBe(401);
    keyRow = { plan: 'pro', revoked_at: '2026-01-01' };
    expect((await handleSuggest(req({ description: 'x' }), env)).status).toBe(401);
  });

  it('403 for a free key', async () => {
    keyRow = { plan: 'free', revoked_at: null };
    expect((await handleSuggest(req({ description: 'x' }), env)).status).toBe(403);
  });

  it('400 for invalid JSON or a missing description', async () => {
    expect((await handleSuggest(req('{nope'), env)).status).toBe(400);
    expect((await handleSuggest(req({ description: '  ' }), env)).status).toBe(400);
  });

  it('200 with the parsed rule on success', async () => {
    const res = await handleSuggest(req({ description: 'never query raw_pii' }), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rule: { rule_type: string } };
    expect(data.rule.rule_type).toBe('forbidden_table');
  });

  it('503 (not 500) when ANTHROPIC_API_KEY is missing', async () => {
    const res = await handleSuggest(req({ description: 'x' }), { ...env, ANTHROPIC_API_KEY: undefined } as unknown as Env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SUGGEST_UNAVAILABLE });
  });

  it('503 (not 502) on an upstream error, with no upstream detail in the response', async () => {
    upstream = () => new Response('UPSTREAM-SECRET-DETAIL', { status: 500 });
    const res = await handleSuggest(req({ description: 'x' }), env);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('UPSTREAM-SECRET-DETAIL');
    expect(text).not.toContain('detail');
  });

  it('503 when Anthropic is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    expect((await handleSuggest(req({ description: 'x' }), env)).status).toBe(503);
  });

  it('422 when the model reply is not a valid rule', async () => {
    upstream = () => new Response(JSON.stringify({ content: [{ text: 'not a rule' }] }));
    expect((await handleSuggest(req({ description: 'x' }), env)).status).toBe(422);
  });
});
