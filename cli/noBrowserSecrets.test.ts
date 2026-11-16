import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// 9.6-SEC Step 5: static guard. Shipped browser source (src/, excluding tests)
// must never read a secret-class VITE_ variable or call an AI provider
// directly. A VITE_ value is baked into the public bundle at build time.

const SRC = resolve(__dirname, '../src');

const SECRET_VITE = /import\.meta\.env\.VITE_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|ANTHROPIC|OPENAI|PRIVATE)[A-Z0-9_]*/;
const PROVIDER_URL = /api\.anthropic\.com|api\.openai\.com/;
const BROWSER_ACCESS = /dangerous-direct-browser-access/;

function shippedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'tests' || name === '__tests__') continue;
      out.push(...shippedFiles(p));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function offenders(re: RegExp): string[] {
  const hits: string[] = [];
  for (const f of shippedFiles(SRC)) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) hits.push(`${relative(SRC, f).replace(/\\/g, '/')}:${i + 1}`);
      });
  }
  return hits;
}

describe('no browser secrets', () => {
  it('scans a real file set', () => {
    expect(shippedFiles(SRC).length).toBeGreaterThan(50);
  });

  it('no secret-class import.meta.env.VITE_ variable in src/', () => {
    expect(offenders(SECRET_VITE)).toEqual([]);
  });

  it('no direct AI-provider URL in src/', () => {
    expect(offenders(PROVIDER_URL)).toEqual([]);
  });

  it('no direct-browser-access header in src/', () => {
    expect(offenders(BROWSER_ACCESS)).toEqual([]);
  });

  it('the patterns do catch what they claim to (self-check)', () => {
    expect(SECRET_VITE.test('import.meta.env.VITE_ANTHROPIC_API_KEY')).toBe(true);
    expect(SECRET_VITE.test('import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY')).toBe(true);
    expect(SECRET_VITE.test('import.meta.env.VITE_CLERK_PUBLISHABLE_KEY')).toBe(false);
    expect(PROVIDER_URL.test("fetch('https://api.openai.com/v1/chat')")).toBe(true);
  });
});
