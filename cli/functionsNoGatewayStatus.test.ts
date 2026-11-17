import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 9.6-API: no Pages Function returns 502 or 504 from code. The custom-domain
// zone replaces an origin 502/504 with Cloudflare's own bare error page (no
// JSON, no CORS headers), so a Function's error body never reaches the browser.
// Upstream failures are 503 (or 500) with JSON instead. See
// docs/502-investigation.md.

const FUNCTIONS = resolve(__dirname, '../functions');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function gatewayStatusLines(src: string): number[] {
  const lines = stripComments(src).split(/\r?\n/);
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (/\b50[24]\b/.test(l)) hits.push(i + 1);
  });
  return hits;
}

describe('Functions never return 502/504', () => {
  it('no 502 or 504 in any Function source (comments excluded)', () => {
    const files = (readdirSync(FUNCTIONS, { recursive: true }) as string[])
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => p.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(30);
    const offenders = files.flatMap((f) => gatewayStatusLines(readFileSync(join(FUNCTIONS, f), 'utf8')).map((n) => `functions/${f}:${n}`));
    expect(offenders).toEqual([]);
  });

  it('the scan catches status codes and ignores comments', () => {
    expect(gatewayStatusLines("return error(502, 'x');")).toEqual([1]);
    expect(gatewayStatusLines('status: ok ? 200 : 504,')).toEqual([1]);
    expect(gatewayStatusLines('// a bare 502 page\n/* 504 */\nreturn error(503, "x");')).toEqual([]);
    expect(gatewayStatusLines("fetch('https://x.test/a') // 502 note")).toEqual([]);
  });
});
