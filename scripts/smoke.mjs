#!/usr/bin/env node
// Live smoke check (9.6-REL). Read-only probes against the deployed site:
//
//   1. GET /                     -> 200, Cache-Control no-cache + must-revalidate
//   2. every JS chunk the app references -> 200
//   3. POST /api/explain, no auth -> 401 JSON
//   4. the leaked pre-9.6-SEC chunk -> 403 (WAF rule)
//   5. the bundled Supabase publishable key reads a table -> 200
//   6. POST /api/checkout, malformed priceId -> 400 JSON
//   7. no same-site absolute /api/ URL in any chunk (outside the allow-list)
//
// Probe 6 deliberately uses a malformed priceId, which the Function rejects
// before it calls Stripe, so a daily run never touches the live Stripe account.
// The upstream-failure mapping (Stripe error/unreachable -> 503 JSON, never
// 502) is covered by unit tests in src/tests/api_checkout.test.ts.
//
// It needs no secrets and prints status codes and counts only. The publishable
// key is read from the public bundle, used once, and never printed.
//
// Usage: node scripts/smoke.mjs [baseUrl]   (or SMOKE_BASE_URL; default https://safesqlpro.dev)

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE = 'https://safesqlpro.dev';
export const LEAKED_CHUNK = '/assets/SqlEditor-DhDscpfX.js';
// RLS returns [] for an anonymous caller; the point is that the key is accepted.
// (The /rest/v1/ schema root returns 401 for a publishable key by design.)
export const SUPABASE_PROBE_PATH = '/rest/v1/validations?select=id&limit=1';

// Absolute /api/ URLs that are shown to users or embedded elsewhere, never
// fetched by the app. Mirrors the allow-list in cli/sameOriginApi.test.ts.
export const ALLOWED_ABSOLUTE_API = [
  /^https:\/\/safesql\.pages\.dev\/api\/validate$/, // public REST API example (Settings)
  /^https?:\/\/[^/]+\/api\/badge\//, // badge Markdown/<img> for external READMEs
];

const SAME_SITE_ABSOLUTE_API = /https?:\/\/(?:[a-z0-9-]+\.)*(?:safesqlpro\.dev|safesql\.pages\.dev|realitydb\.dev)\/api\/[^\s"'`)\\]*/g;
const ORIGIN_CONCAT_API = /origin\s*\+\s*["'`]\/api\//g;

/** Script chunks referenced by index.html (<script src> and modulepreload). */
export function indexChunks(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]))];
}

/**
 * Chunk paths a JS chunk refers to: "assets/X-hash.js" in Vite's preload
 * lists, and "./X-hash.js" in dynamic imports between chunks (all chunks sit
 * in /assets/). The 8-character hash suffix keeps unrelated "./foo.js" strings
 * from library code out.
 */
export function referencedChunks(js) {
  const prefixed = [...js.matchAll(/assets\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js)/g)].map((m) => m[1]);
  const relative = [...js.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js)["'`]/g)].map((m) => m[1]);
  return [...new Set([...prefixed, ...relative])].map((f) => `/assets/${f}`);
}

export function cacheControlOk(header) {
  const h = String(header ?? '').toLowerCase();
  return h.includes('no-cache') && h.includes('must-revalidate');
}

/** The publishable key and project URL from bundle text. Never log `key`. */
export function supabaseFromBundle(text) {
  const keys = [...new Set(text.match(/sb_publishable_[A-Za-z0-9_-]+/g) ?? [])];
  const urls = [...new Set(text.match(/https:\/\/[a-z0-9]+\.supabase\.co/g) ?? [])];
  return { keyCount: keys.length, key: keys[0], urlCount: urls.length, url: urls[0] };
}

/** Same-site absolute /api/ URLs (and origin + '/api' concatenations) not on the allow-list. */
export function absoluteApiOffenders(text) {
  const hits = (text.match(SAME_SITE_ABSOLUTE_API) ?? []).filter((u) => !ALLOWED_ABSOLUTE_API.some((re) => re.test(u)));
  const concat = (text.match(ORIGIN_CONCAT_API) ?? []).map(() => "origin + '/api/'");
  return [...new Set([...hits, ...concat])];
}

const isJson = (res) => /application\/json/i.test(res.headers.get('content-type') ?? '');

// One retry on a network error (not on an HTTP status): a transient DNS
// failure resolving *.supabase.co was seen once during Step 0.
async function get(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

const postJson = (url, body, headers = {}) =>
  get(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

export async function runSmoke(base = DEFAULT_BASE, log = console.log) {
  base = base.replace(/\/+$/, '');
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
    } catch (e) {
      results.push({ name, ok: false });
      log(`FAIL ${name}: ${e?.message ?? e}`);
    }
  };
  const expectStatus = (res, want) => {
    if (res.status !== want) throw new Error(`expected ${want}, got ${res.status}`);
  };

  let html = '';
  await check('index.html 200 + no-cache, must-revalidate', async () => {
    const res = await get(`${base}/`);
    expectStatus(res, 200);
    // Read the body first so a header failure doesn't cascade into the chunk,
    // key and URL probes: each check reports on its own.
    html = await res.text();
    const cc = res.headers.get('cache-control');
    if (!cacheControlOk(cc)) throw new Error(`Cache-Control is "${cc}"`);
    return `Cache-Control "${cc}"`;
  });

  const chunks = new Map(); // path -> text
  await check('every referenced JS chunk returns 200', async () => {
    const queue = indexChunks(html);
    if (queue.length === 0) throw new Error('index.html references no /assets/*.js');
    const bad = [];
    while (queue.length) {
      const p = queue.shift();
      if (chunks.has(p) || p === LEAKED_CHUNK) continue;
      const res = await get(`${base}${p}`);
      if (res.status !== 200) {
        bad.push(`${p} ${res.status}`);
        chunks.set(p, '');
        continue;
      }
      const js = await res.text();
      chunks.set(p, js);
      for (const r of referencedChunks(js)) if (!chunks.has(r)) queue.push(r);
    }
    if (bad.length) throw new Error(`${bad.length} chunk(s) not 200: ${bad.join(', ')}`);
    return `${chunks.size} chunks`;
  });
  const bundle = [...chunks.values()].join('\n');

  await check('POST /api/explain without auth -> 401 JSON', async () => {
    const res = await postJson(`${base}/api/explain`, {});
    expectStatus(res, 401);
    if (!isJson(res)) throw new Error('not JSON');
  });

  await check('leaked pre-9.6-SEC chunk -> 403', async () => {
    expectStatus(await get(`${base}${LEAKED_CHUNK}`), 403);
  });

  await check('bundled Supabase publishable key reads a table -> 200', async () => {
    const sb = supabaseFromBundle(bundle);
    if (sb.keyCount !== 1) throw new Error(`expected 1 publishable key in the bundle, found ${sb.keyCount}`);
    if (sb.urlCount !== 1) throw new Error(`expected 1 Supabase URL in the bundle, found ${sb.urlCount}`);
    const res = await get(`${sb.url}${SUPABASE_PROBE_PATH}`, { headers: { apikey: sb.key } });
    expectStatus(res, 200);
    return 'key not printed';
  });

  await check('POST /api/checkout malformed priceId -> 400 JSON (no Stripe call)', async () => {
    const res = await postJson(`${base}/api/checkout`, { priceId: 'not-a-price' });
    expectStatus(res, 400);
    if (!isJson(res)) throw new Error('not JSON');
  });

  await check('no same-site absolute /api/ URL in the bundle (allow-list aside)', async () => {
    if (!bundle) throw new Error('no bundle text to scan');
    const off = absoluteApiOffenders(bundle);
    if (off.length) throw new Error(`${off.length} offender(s): ${off.join(', ')}`);
  });

  const passed = results.filter((r) => r.ok).length;
  log(`smoke: ${passed}/${results.length} passed against ${base}`);
  return { passed, total: results.length, ok: passed === results.length };
}

async function main() {
  const base = process.argv[2] ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE;
  const { ok } = await runSmoke(base);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
