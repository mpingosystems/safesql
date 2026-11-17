import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createMatcher,
  denylistMatcher,
  FIRST_TOKEN_HMACS,
  keyedHash,
  keyMatchesLists,
  loadKey,
  sha256,
  termKey,
  TERM_HMACS,
  // @ts-expect-error: plain .mjs script, no type declarations
} from '../scripts/check-leaks.mjs';

// Leak guard: no private working-context names in the public repo. Planted
// terms are assembled at test time, so this file itself stays clean (the guard
// scans it too). The denylist holds HMAC-SHA256 values; tests that need the
// real list run only when the key is available (locally via the gitignored
// key-path file, in CI via the LEAK_CHECK_KEY secret). Everything else uses a
// throwaway test key.

const SCRIPT = resolve(__dirname, '../scripts/check-leaks.mjs');
const REPO = resolve(__dirname, '..');
const j = (...parts: string[]) => parts.join('');
const BS = '\\';
const TEST_KEY = 'test-key-not-the-real-one';

const REAL = loadKey() as { key: string | null };
const hasKey = Boolean(REAL.key);

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

function run(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// An environment with no key source at all (LEAK_CHECK_KEY_FILE set to a
// missing file stops the lookup before the local key-path file).
function noKeyEnv(ci: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LEAK_CHECK_KEY: '', LEAK_CHECK_KEY_FILE: join(tmpdir(), 'no-such-leak-key-file') };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  if (ci) env.CI = 'true';
  return env;
}

describe('keyed denylist (HMAC-SHA256)', () => {
  it('stores HMAC values only: a guess hashed with plain SHA-256 matches nothing', () => {
    const guesses = [...Object.values(PLANTED), j('reality', 'db-', 'internal'), j('ai-', 'workflow/'), j('STATE', '.md')];
    for (const g of guesses) {
      for (const k of [termKey(g), ...termKey(g).split(/[^a-z0-9]+/).filter(Boolean)]) {
        expect(TERM_HMACS.has(sha256(k))).toBe(false);
        expect(FIRST_TOKEN_HMACS.has(sha256(k))).toBe(false);
      }
    }
    expect(TERM_HMACS.size).toBeGreaterThan(90);
    for (const v of TERM_HMACS) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different key matches nothing in the shipped lists', () => {
    expect(keyMatchesLists(TEST_KEY)).toBe(false);
    const wrong = denylistMatcher(TEST_KEY);
    for (const line of Object.values(PLANTED)) expect(wrong(`// ${line}`)).toBe(false);
  });

  it('with a test key, a planted term is caught', () => {
    const term = j('Jane', ' Q', ' Example');
    const k = termKey(term);
    const match = createMatcher(new Set([keyedHash(TEST_KEY, k)]), new Set([keyedHash(TEST_KEY, 'jane')]), TEST_KEY);
    expect(match(`Met ${term} today`)).toBe(true);
    // The same lists are useless with another key, and with plain SHA-256.
    expect(createMatcher(new Set([keyedHash(TEST_KEY, k)]), new Set([keyedHash(TEST_KEY, 'jane')]), 'other-key')(term)).toBe(false);
    expect(createMatcher(new Set([sha256(k)]), new Set([sha256('jane')]), TEST_KEY)(term)).toBe(false);
  });
});

describe.skipIf(!hasKey)('shipped denylist (needs the real key)', { timeout: 60_000 }, () => {
  const lineHasTerm = hasKey ? denylistMatcher(REAL.key) : () => false;

  it('the loaded key matches the lists', () => {
    expect(keyMatchesLists(REAL.key)).toBe(true);
  });

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

  // Ordinary prose that shares words with the kinds of names on the denylist
  // (banks, health systems, first names, document-style words).
  it.each([
    'The bank of the river is in America.',
    'Run a health check before the merge; advocate for smaller PRs.',
    'Ben, Sarah and Luke reviewed the pipeline for the sales team.',
    'testing the -ing form of a verb',
    'session starter, master plan, architecture doc, solutions list',
    'SafeSQL Pro is a dbt Technology Partner; checkout uses Stripe.',
  ])('does not flag common words: %s', (line) => {
    expect(lineHasTerm(line)).toBe(false);
  });
});

// Multi-word terms (people, organisations) are matched across whitespace.
// Uses its own planted list and test key, so no real term appears here.
describe('createMatcher: whitespace-tolerant terms', () => {
  const person = j('Jane', ' Q', ' Example');
  const org = j('Acme', ' Widget', ' Bank');
  const doc = j('ACME', '-SECRET', '-PLAN');
  const terms = [person, org, doc];
  const match = createMatcher(
    new Set(terms.map((t) => keyedHash(TEST_KEY, termKey(t)))),
    new Set(terms.map((t) => keyedHash(TEST_KEY, termKey(t).split(/[^a-z0-9]/)[0]))),
    TEST_KEY,
  );

  it('normalises a term to lowercase tokens joined by single spaces', () => {
    expect(termKey(j('  Jane', '\t Q  ', 'Example '))).toBe('jane q example');
    expect(termKey(doc)).toBe('acme-secret-plan');
  });

  it.each([
    `Met ${person} on Tuesday.`,
    `contact: ${person.toUpperCase()}`,
    j('| Jane', '   Q\t', 'Example | CDO |'),
    `Pipeline: ${org} (queued)`,
    `see ${doc}.md`,
  ])('flags %s', (line) => {
    expect(match(line)).toBe(true);
  });

  it.each([
    'Jane reviewed the change.',
    j('Jane', ' Example'),
    j('Jane', 'QExample'),
    j('Acme', ' Widget'),
    j('Acme', ' Widget,', ' Bank'),
    j('ACME', ' - SECRET', ' - PLAN'),
    'An example bank of widgets',
  ])('does not flag %s', (line) => {
    expect(match(line)).toBe(false);
  });
});

// Spawn-heavy (git + node per test; the self-scan reads every tracked file):
// under the full parallel suite these run past vitest's 5 s default.
describe('check-leaks CLI: key handling', { timeout: 60_000 }, () => {
  it('fails loudly in CI when no key is available', () => {
    const dir = repo('nokey-ci', { 'a.txt': 'ok\n' });
    const r = run(dir, noKeyEnv(true));
    expect(r.code).toBe(2);
    expect(r.out).toContain('leak check: FAILED: no key');
  });

  it('warns locally when no key is available, and never reports a pass', () => {
    const dir = repo('nokey-local', { 'a.txt': 'ok\n' });
    const r = run(dir, noKeyEnv(false));
    expect(r.code).toBe(0);
    expect(r.out).toContain('leak check: SKIPPED, NOT RUN');
    expect(r.out).not.toMatch(/\d+ findings/);
  });

  it('fails when the key does not match the lists, and never prints the key', () => {
    const dir = repo('wrongkey', { 'a.txt': 'ok\n' });
    const r = run(dir, { ...noKeyEnv(false), LEAK_CHECK_KEY: TEST_KEY });
    expect(r.code).toBe(2);
    expect(r.out).toContain('fingerprint mismatch');
    expect(r.out).not.toContain(TEST_KEY);
  });
});

describe.skipIf(!hasKey)('check-leaks CLI: scanning (needs the real key)', { timeout: 60_000 }, () => {
  it('passes a clean repo', () => {
    const dir = repo('clean', { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# Hello\n' });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('leak check: 2 files, 0 findings');
  });

  it('fails on a planted term and names file:line, never the term or the key', () => {
    const dir = repo('planted', { 'src/a.ts': `const x = 1;\n// tracked in ${PLANTED.internalRepo}/notes.md\n` });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.ts:2: refers to private working context');
    expect(r.out).toContain('1 findings');
    expect(r.out.toLowerCase()).not.toContain(PLANTED.internalRepo);
    expect(r.out).not.toContain(String(REAL.key));
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
