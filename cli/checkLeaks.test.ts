import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error: plain .mjs script, no type declarations
import { lineHasTerm } from '../scripts/check-leaks.mjs';

// Leak guard: no private working-context names in the public repo. Planted
// terms are assembled at test time, so this file itself stays clean (the guard
// scans it too).

const SCRIPT = resolve(__dirname, '../scripts/check-leaks.mjs');
const REPO = resolve(__dirname, '..');
const j = (...parts: string[]) => parts.join('');
const BS = '\\';

const PLANTED = {
  internalRepo: j('reality', 'db-', 'internal'),
  internalFolder: j('05', '-safe', 'sql'),
  sprintDoc: j('SAFESQL', '-SPR', 'INT9.6-OPS-PROMPT.md'),
  winPath: j('C:', BS, 'Users', BS, 'HP', BS, 'Docu', 'ments', BS, 'x'),
  escapedWinPath: j('C:', BS, BS, 'Users', BS, BS, 'HP', BS, BS, 'Docu', 'ments'),
  bashPath: j('/c/Users/HP/', 'Docu', 'ments/x'),
  stateFile: j('see ', 'STATE', '.md'),
};

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'safesql-leaks-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function repo(name: string, files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  const put = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  };
  for (const [rel, c] of Object.entries(files)) put(rel, c);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  for (const [rel, c] of Object.entries(untracked)) put(rel, c);
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('lineHasTerm', { timeout: 60_000 }, () => {
  it.each(Object.entries(PLANTED))('flags %s', (_k, line) => {
    expect(lineHasTerm(`// note: ${line} here`)).toBe(true);
  });

  it.each(['import { apiUrl } from "./config/api";', 'see docs/502-investigation.md', 'node scripts/state.mjs --print', 'const safesql = 1; // sprint', 'C:/Users/someone/Desktop'])(
    'does not flag %s',
    (line) => {
      expect(lineHasTerm(line)).toBe(false);
    },
  );

  it('needs the tokens to be adjacent', () => {
    expect(lineHasTerm(j('reality', 'db - ', 'internal'))).toBe(false);
  });
});

// Spawn-heavy (git + node per test; the self-scan reads every tracked file):
// under the full parallel suite these run past vitest's 5 s default.
describe('check-leaks CLI', { timeout: 60_000 }, () => {
  it('passes a clean repo', () => {
    const dir = repo('clean', { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# Hello\n' });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('leak check: 2 files, 0 findings');
  });

  it('fails on a planted term and names file:line, never the term', () => {
    const dir = repo('planted', { 'src/a.ts': `const x = 1;\n// tracked in ${PLANTED.internalRepo}/notes.md\n` });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.ts:2: refers to private working context');
    expect(r.out).toContain('1 findings');
    expect(r.out.toLowerCase()).not.toContain(PLANTED.internalRepo);
  });

  it('fails when a private working-context folder exists in the repo, even untracked', () => {
    const dir = repo('folder', { 'a.txt': 'ok\n' }, { [j('ai-', 'workflow/', 'notes.md')]: 'x\n' });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('path names private working context');
  });

  it('respects .gitignore for untracked files (the local path file is ignored)', () => {
    const dir = repo('ignored', { '.gitignore': 'local-notes/\n' }, { [j('local-notes/', 'ai-', 'workflow/', 'x.md')]: 'x\n' });
    expect(run(dir).code).toBe(0);
  });

  it('the repository itself is clean', () => {
    const r = run(REPO);
    expect(r.out).toMatch(/leak check: \d+ files, 0 findings/);
    expect(r.code).toBe(0);
  });
});
