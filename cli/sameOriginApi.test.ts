import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { apiUrl } from '../src/config/api';

// 9.6-API: every browser call to our own /api/* is same-origin and relative,
// so no browser request depends on CORS. apiUrl() has no base override, and
// browser code never builds an absolute /api URL.
//
// The allow-list covers strings that are shown to users or embedded elsewhere,
// never fetched by the app: the badge Markdown/<img> for external READMEs and
// the public REST API example. Each entry is matched exactly and counted, so a
// new absolute /api URL anywhere in src/ fails this test.

const SRC = resolve(__dirname, '../src');

const ALLOWED: { file: string; text: string; count: number; why: string }[] = [
  { file: 'pages/Settings.tsx', text: '${SITE_URL}/api/badge/', count: 2, why: 'badge for external READMEs; must be absolute' },
  { file: 'pages/Settings.tsx', text: 'https://safesql.pages.dev/api/validate', count: 2, why: 'public REST API example shown to users' },
];

const ABSOLUTE_API = [
  /https?:\/\/[^\s'"`)]*\/api\//g, // literal origin + /api/
  /\$\{[^}]+\}\/api\//g, // `${base}/api/...`
  /origin\s*\+\s*['"`]\/api/g, // location.origin + '/api'
];

function browserFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith('tests/'));
}

describe('same-origin /api calls', () => {
  it('apiUrl() returns a relative path', () => {
    expect(apiUrl('/api/teams/events')).toBe('/api/teams/events');
    expect(apiUrl('api/explain')).toBe('/api/explain');
    expect(apiUrl('/api/teams/rules?include_inactive=true')).toBe('/api/teams/rules?include_inactive=true');
  });

  it('no browser code reads a base-URL override', () => {
    const offenders = browserFiles().filter((f) => /env\s*\.\s*VITE_API_BASE_URL|\[['"]VITE_API_BASE_URL['"]\]/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no browser code builds an absolute /api URL (outside the allow-list)', () => {
    const files = browserFiles();
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of files) {
      let text = readFileSync(join(SRC, f), 'utf8');
      for (const a of ALLOWED.filter((x) => x.file === f)) {
        const n = text.split(a.text).length - 1;
        expect(n, `${f}: allow-listed "${a.text}" (${a.why})`).toBe(a.count);
        text = text.split(a.text).join('');
      }
      text.split(/\r?\n/).forEach((line, i) => {
        if (ABSOLUTE_API.some((re) => new RegExp(re.source).test(line))) offenders.push(`${relative(SRC, join(SRC, f))}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the scan catches the patterns it is meant to catch', () => {
    const hit = (line: string) => ABSOLUTE_API.some((re) => new RegExp(re.source).test(line));
    expect(hit("fetch('https://safesql.pages.dev/api/teams/events')")).toBe(true);
    expect(hit('fetch(`${API_BASE}/api/explain`)')).toBe(true);
    expect(hit("fetch(window.location.origin + '/api/checkout')")).toBe(true);
    expect(hit("fetch('/api/teams/events')")).toBe(false);
    expect(hit("fetch(apiUrl('/api/explain'))")).toBe(false);
  });
});
