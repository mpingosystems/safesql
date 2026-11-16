import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error: plain .mjs script, no type declarations
import { scanText, formatReport } from '../scripts/check-bundle-secrets.mjs';

// 9.6-SEC Step 4: postbuild secret scan of dist/. Every fixture value is
// synthetic, assembled at test time, and obviously fake. No realistic key is
// committed, and the key prefixes never appear verbatim in this file.

const SCRIPT = resolve(__dirname, '../scripts/check-bundle-secrets.mjs');
const fill = (n: number) => 'FAKE0'.repeat(Math.ceil(n / 5)).slice(0, n);
const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: object) =>
  [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), 'FAKEsignatureFAKEsignature'].join('.');

const FAKES: Record<string, string> = {
  anthropic_api_key: ['sk', 'ant', fill(24)].join('-'),
  stripe_secret_key: ['sk', 'live', fill(16)].join('_'),
  stripe_restricted_key: ['rk', 'live', fill(16)].join('_'),
  safesql_api_key: ['ssk', 'live', 'Ab-' + fill(29)].join('_'),
  supabase_service_role_jwt: jwt({ iss: 'supabase', ref: 'fakeref', role: 'service_role' }),
};

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'safesql-secret-scan-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('scanText', () => {
  it.each(Object.entries(FAKES))('detects %s', (type, value) => {
    expect(scanText(`const x = "${value}";`)).toContain(type);
  });

  it('a SafeSQL key is not double-reported as a Stripe key', () => {
    expect(scanText(FAKES.safesql_api_key)).toEqual(['safesql_api_key']);
  });

  it('catches a service-role JWT at any base64 alignment', () => {
    for (const pad of ['', 'x', 'xy']) {
      expect(scanText(jwt({ pad, role: 'service_role' }))).toContain('supabase_service_role_jwt');
    }
  });

  it('does not flag the browser-safe Supabase anon key or publishable keys', () => {
    const anon = jwt({ iss: 'supabase', ref: 'fakeref', role: 'anon' });
    const pk = ['pk', 'live', fill(20)].join('_');
    expect(scanText(`${anon} ${pk} sk_live_ placeholder`)).toEqual([]);
  });
});

describe('check-bundle-secrets.mjs (CLI)', () => {
  it('clean dist passes with "N files, 0 findings"', () => {
    const dir = fixture('clean', { 'index.html': '<html></html>', 'assets/app.js': 'console.log(1)' });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('secret scan: 2 files, 0 findings');
  });

  it.each(Object.entries(FAKES))('fails the build on %s and never prints the match', (type, value) => {
    const dir = fixture(`dirty-${type}`, { 'assets/chunk-abc.js': `var k="${value}";`, 'index.html': '<html></html>' });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain(type);
    expect(r.out).toContain('assets/chunk-abc.js');
    expect(r.out).not.toContain(value);
  });

  it('fails when the directory is missing', () => {
    expect(run(join(work, 'does-not-exist')).code).toBe(1);
  });

  it('formatReport never includes matched text', () => {
    const text = formatReport({ files: 3, findings: [{ file: 'a.js', type: 'anthropic_api_key' }] });
    expect(text).toContain('anthropic_api_key in a.js');
    expect(text).toContain('1 findings');
  });
});
