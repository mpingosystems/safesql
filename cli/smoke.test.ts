import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absoluteApiOffenders,
  cacheControlOk,
  indexChunks,
  LEAKED_CHUNK,
  referencedChunks,
  runSmoke,
  supabaseFromBundle,
  SUPABASE_PROBE_PATH,
} from '../scripts/smoke.mjs';

// 9.6-REL: scripts/smoke.mjs helpers, plus a full run against a mocked site so
// the probe wiring is tested without the network.

const ROOT = join(__dirname, '..');
// Built at runtime so this file never contains a key-shaped literal.
const FAKE_KEY = ['sb', 'publishable', 'TESTONLYnotarealkey123'].join('_');

describe('smoke helpers', () => {
  it('indexChunks reads script src and modulepreload hrefs', () => {
    const html =
      '<script type="module" crossorigin src="/assets/index-AbCdEf12.js"></script>' +
      '<link rel="modulepreload" crossorigin href="/assets/vendor-12345678.js">' +
      '<link rel="stylesheet" href="/assets/index-Zz.css">';
    expect(indexChunks(html)).toEqual(['/assets/index-AbCdEf12.js', '/assets/vendor-12345678.js']);
  });

  it('referencedChunks finds preload-list and relative dynamic-import chunks', () => {
    const js = 'm.f||(m.f=["assets/SqlEditor-DC26iSvu.js","assets/chunk-CilyBKbf.js"]);import("./Editor-DAxfv53X.js");x="./plain.js"';
    expect(referencedChunks(js).sort()).toEqual(
      ['/assets/Editor-DAxfv53X.js', '/assets/SqlEditor-DC26iSvu.js', '/assets/chunk-CilyBKbf.js'].sort(),
    );
  });

  it('cacheControlOk needs both no-cache and must-revalidate', () => {
    expect(cacheControlOk('must-revalidate, no-cache')).toBe(true);
    expect(cacheControlOk('no-cache')).toBe(false);
    expect(cacheControlOk('public, max-age=31536000, immutable')).toBe(false);
    expect(cacheControlOk(null)).toBe(false);
  });

  it('supabaseFromBundle counts keys and URLs', () => {
    const sb = supabaseFromBundle(`a="${FAKE_KEY}";b="https://abcdef.supabase.co";c="${FAKE_KEY}"`);
    expect(sb).toMatchObject({ keyCount: 1, urlCount: 1, url: 'https://abcdef.supabase.co' });
    expect(sb.key).toBe(FAKE_KEY);
    expect(supabaseFromBundle('nothing').keyCount).toBe(0);
  });

  it('absoluteApiOffenders allows the REST example and badge URLs only', () => {
    expect(absoluteApiOffenders('"https://safesql.pages.dev/api/validate"')).toEqual([]);
    expect(absoluteApiOffenders('`https://safesqlpro.dev/api/badge/abc`')).toEqual([]);
    expect(absoluteApiOffenders('fetch("https://safesqlpro.dev/api/explain")')).toEqual(['https://safesqlpro.dev/api/explain']);
    expect(absoluteApiOffenders('fetch("https://safesql.pages.dev/api/teams/events")')).toHaveLength(1);
    expect(absoluteApiOffenders('fetch(location.origin+"/api/x")')).toEqual(["origin + '/api/'"]);
    expect(absoluteApiOffenders('fetch("/api/explain");u="https://api.stripe.com/v1"')).toEqual([]);
  });

  it('documents that the checkout 503 mapping lives in unit tests, and that file exists', () => {
    const src = readFileSync(join(ROOT, 'scripts/smoke.mjs'), 'utf8');
    expect(src).toContain('src/tests/api_checkout.test.ts');
    expect(readFileSync(join(ROOT, 'src/tests/api_checkout.test.ts'), 'utf8')).toMatch(/503/);
  });

  it('is wired as npm run smoke', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.smoke).toBe('node scripts/smoke.mjs');
  });
});

// A mocked healthy site. `broken` flips individual probes to failure.
function site(broken: Partial<Record<'cache' | 'explain' | 'leaked' | 'supabase' | 'checkout' | 'absolute' | 'chunk', boolean>> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const entry = `import("./Lazy-ABCDEFGH.js");k="${FAKE_KEY}";u="https://proj.supabase.co";` +
    (broken.absolute ? 'fetch("https://safesqlpro.dev/api/explain")' : 'fetch("/api/explain")');
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (status: number) => new Response('{}', { status, headers: { 'content-type': 'application/json' } });
    const u = new URL(url);
    if (u.host === 'proj.supabase.co') return new Response('[]', { status: broken.supabase ? 401 : 200 });
    switch (u.pathname) {
      case '/':
        return new Response('<script type="module" src="/assets/index-12345678.js"></script>', {
          status: 200,
          headers: { 'cache-control': broken.cache ? 'max-age=600' : 'no-cache, must-revalidate' },
        });
      case '/assets/index-12345678.js':
        return new Response(entry);
      case '/assets/Lazy-ABCDEFGH.js':
        return new Response('lazy', { status: broken.chunk ? 404 : 200 });
      case LEAKED_CHUNK:
        return new Response('', { status: broken.leaked ? 200 : 403 });
      case '/api/explain':
        return json(broken.explain ? 200 : 401);
      case '/api/checkout':
        return json(broken.checkout ? 503 : 400);
      default:
        return new Response('', { status: 404 });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('runSmoke against a mocked site', () => {
  it('passes all 7 checks on a healthy site and never prints the key', async () => {
    const calls = site();
    const lines: string[] = [];
    const r = await runSmoke('https://example.test/', (l: string) => lines.push(l));
    expect(r).toEqual({ passed: 7, total: 7, ok: true });
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
    const sb = calls.find((c) => c.url.startsWith('https://proj.supabase.co'));
    expect(sb?.url).toBe(`https://proj.supabase.co${SUPABASE_PROBE_PATH}`);
    expect((sb?.init?.headers as Record<string, string>).apikey).toBe(FAKE_KEY);
    expect(calls.some((c) => c.url.endsWith('/assets/Lazy-ABCDEFGH.js'))).toBe(true);
    const checkout = calls.find((c) => c.url.endsWith('/api/checkout'));
    expect(JSON.parse(String(checkout?.init?.body))).toEqual({ priceId: 'not-a-price' });
    expect(calls.some((c) => c.url.includes('stripe.com'))).toBe(false);
  });

  for (const k of ['cache', 'explain', 'leaked', 'supabase', 'checkout', 'absolute', 'chunk'] as const) {
    it(`fails when ${k} is broken`, async () => {
      site({ [k]: true });
      const lines: string[] = [];
      const r = await runSmoke('https://example.test', (l: string) => lines.push(l));
      expect(r.ok).toBe(false);
      expect(r.passed).toBe(6);
      expect(lines.filter((l) => l.startsWith('FAIL'))).toHaveLength(1);
      expect(lines.join('\n')).not.toContain(FAKE_KEY);
    });
  }
});
