import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// scripts/state.mjs: session state report. Fixtures are throwaway git repos and
// a throwaway working-context folder; nothing real is read.

const SCRIPT = resolve(__dirname, '../scripts/state.mjs');
const OUT_NAME = ['STATE', 'md'].join('.');

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'safesql-state-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const G = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

function codeRepo(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, ...G, 'commit', '-q', '-m', 'first fixture commit']);
  execFileSync('git', ['-C', dir, ...G, 'tag', 'v9.9.9']);
  execFileSync('git', ['-C', dir, ...G, 'tag', 'v1']);
  return dir;
}

function internalDir(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current-sprint.txt'), 'sprint: FIX-1 (fixture sprint)\nstep: Step 2 of 4\nnext: run the fixture next action\n');
  writeFileSync(
    join(dir, 'uncertainty-register.md'),
    [
      '# reg',
      '',
      '| ID | Level | Item | Resolves when | Status |',
      '|---|---|---|---|---|',
      '| U-1 | Critical → closed later | critical open item | x | open |',
      '| U-2 | Material | material open item | x | open: half done |',
      '| U-3 | Material | material resolved item | x | resolved (2026-01-01) |',
      '| U-4 | Low | low open item | x | open |',
      '',
    ].join('\n'),
  );
  const rows = Array.from({ length: 7 }, (_, i) => `| 2026-01-0${i + 1} | H${i + 1} | decision number ${i + 1} | Owner |`);
  writeFileSync(join(dir, 'decision-log.md'), ['# log', '', '| Date | Code | Decision | Decided by |', '|---|---|---|---|', ...rows, ''].join('\n'));
  writeFileSync(join(dir, 'queue.md'), '# q\n\n## Next\n- ALPHA: first next item\n\n## Then\n- BETA: later item\n- GAMMA: last item\n');
  return dir;
}

function run(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const base = { ...process.env };
  delete base.SAFESQL_INTERNAL_DIR;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('state.mjs --print', { timeout: 60_000 }, () => {
  it('with no working context prints only public fields', () => {
    const repo = codeRepo('public-only');
    const r = run(repo, ['--print']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Version: 9.9.9 (package.json) · latest tag v9.9.9');
    expect(r.out).toContain('first fixture commit');
    expect(r.out).toContain('public subset only');
    for (const section of ['## Current sprint', '## Open uncertainties', '## Last 5 decisions', '## Queue']) {
      expect(r.out).not.toContain(section);
    }
  });

  it('with a working-context folder (env var) renders every section', () => {
    const repo = codeRepo('full');
    const dir = internalDir('ctx-env');
    const r = run(repo, ['--print'], { SAFESQL_INTERNAL_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('public subset only');
    expect(r.out).toContain('Sprint: FIX-1 (fixture sprint)');
    expect(r.out).toContain('Step: Step 2 of 4');
    expect(r.out).toContain('**Next action:** run the fixture next action');
    // Open Critical/Material only.
    expect(r.out).toContain('U-1 (Critical): critical open item');
    expect(r.out).toContain('U-2 (Material): material open item');
    expect(r.out).not.toContain('material resolved item');
    expect(r.out).not.toContain('low open item');
    // Last five decisions only.
    expect(r.out).toContain('decision number 7');
    expect(r.out).toContain('decision number 3');
    expect(r.out).not.toContain('decision number 2');
    // Queue.
    expect(r.out).toContain('- ALPHA: first next item');
    expect(r.out).toContain('**Then:** BETA → GAMMA');
    // --print writes nothing.
    expect(existsSync(join(dir, OUT_NAME))).toBe(false);
  });

  it('reads the gitignored path file when the env var is not set', () => {
    const repo = codeRepo('path-file');
    const dir = internalDir('ctx-file');
    writeFileSync(join(repo, '.safesql-internal-path'), `${dir}\n`);
    const r = run(repo, ['--print']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Sprint: FIX-1 (fixture sprint)');
  });

  it('never prints the working-context path', () => {
    const repo = codeRepo('no-path');
    const dir = internalDir('ctx-secret-location');
    const r = run(repo, ['--print'], { SAFESQL_INTERNAL_DIR: dir });
    expect(r.out).not.toContain('ctx-secret-location');
  });
});

describe('state.mjs --write', { timeout: 60_000 }, () => {
  it('writes the state file into the working-context folder', () => {
    const repo = codeRepo('write');
    const dir = internalDir('ctx-write');
    const r = run(repo, ['--write'], { SAFESQL_INTERNAL_DIR: dir });
    expect(r.code).toBe(0);
    const written = readFileSync(join(dir, OUT_NAME), 'utf8');
    expect(written).toContain('## Current sprint');
    expect(existsSync(join(repo, OUT_NAME))).toBe(false);
  });

  it('refuses to write without a working-context folder', () => {
    const repo = codeRepo('write-none');
    const r = run(repo, ['--write']);
    expect(r.code).toBe(1);
  });

  it('rejects an unknown mode', () => {
    expect(run(codeRepo('bad-mode'), ['--nope']).code).toBe(2);
  });
});
