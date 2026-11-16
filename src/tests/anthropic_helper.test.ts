import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_MODEL, aiUnavailable, callAnthropic } from '../../functions/api/_shared/anthropic';

// 9.6-SEC Step 1: shared server-side Anthropic helper. All keys below are
// obviously fake and never resemble a real key format.
const env = { ANTHROPIC_API_KEY: 'test-key-not-real' };
const opts = { messages: [{ role: 'user' as const, content: 'PROMPT-BODY-MARKER' }], maxTokens: 10 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('callAnthropic', () => {
  it('returns not_configured without calling fetch when the key is missing', async () => {
    const fetchFn = stubFetch(async () => new Response('{}'));
    const r = await callAnthropic({}, opts);
    expect(r).toEqual({ ok: false, reason: 'not_configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts to the Messages API with the shared model and returns the text', async () => {
    const fetchFn = stubFetch(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hello' }] })));
    const r = await callAnthropic(env, { ...opts, system: 'sys' });
    expect(r).toEqual({ ok: true, text: 'hello' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(ANTHROPIC_MODEL);
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBe(10);
    expect((init?.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBeUndefined();
  });

  it('maps 429 to rate_limited and 5xx/other errors to upstream_error', async () => {
    stubFetch(async () => new Response('slow down', { status: 429 }));
    expect(await callAnthropic(env, opts)).toEqual({ ok: false, reason: 'rate_limited', status: 429 });
    stubFetch(async () => new Response('boom', { status: 529 }));
    expect(await callAnthropic(env, opts)).toEqual({ ok: false, reason: 'upstream_error', status: 529 });
    stubFetch(async () => new Response('bad key', { status: 401 }));
    expect(await callAnthropic(env, opts)).toEqual({ ok: false, reason: 'upstream_error', status: 401 });
  });

  it('times out via AbortController', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    expect(await callAnthropic(env, { ...opts, timeoutMs: 5 })).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps network failure to unreachable', async () => {
    stubFetch(async () => {
      throw new TypeError('network down');
    });
    expect(await callAnthropic(env, opts)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('logs only status, latency and model: never request or response bodies', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(async () => new Response(JSON.stringify({ content: [{ text: 'RESPONSE-BODY-MARKER' }] })));
    await callAnthropic(env, opts);
    const logged = [...log.mock.calls, ...err.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain('PROMPT-BODY-MARKER');
    expect(logged).not.toContain('RESPONSE-BODY-MARKER');
    expect(logged).not.toContain(env.ANTHROPIC_API_KEY);
    const entry = JSON.parse(String(log.mock.calls[0][0]));
    expect(Object.keys(entry).sort()).toEqual(['event', 'latencyMs', 'model', 'status']);
  });
});

describe('aiUnavailable', () => {
  it('is a readable 503 JSON error', async () => {
    const res = aiUnavailable('AI explanations are temporarily unavailable');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'AI explanations are temporarily unavailable' });
  });
});
