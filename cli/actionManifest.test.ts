import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 9.6-REL: the Action's declared inputs are exactly the inputs it reads.
// `uses: mpingosystems/safesql@v1` resolves to the ROOT action.yml, while the
// source and bundle live in action/, so the two manifests must stay in sync.
// v0.11.3 removed `api_key`, which was declared but never read: the Action runs
// all 35 detectors locally and never sends SQL off the runner.

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Input names under the top-level `inputs:` key (two-space indented keys).
function declaredInputs(yml: string): string[] {
  const block = /^inputs:\r?\n([\s\S]*?)^\S/m.exec(yml);
  if (!block) throw new Error('no inputs block');
  return [...block[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
}

function readInputs(src: string): string[] {
  return [...new Set([...src.matchAll(/core\.getInput\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
}

describe('GitHub Action manifest', () => {
  const root = declaredInputs(read('action.yml'));
  const inner = declaredInputs(read('action/action.yml'));
  const used = readInputs(read('action/src/index.ts'));

  it('root and action/ manifests declare the same inputs', () => {
    expect(root).toEqual(inner);
  });

  it('declares exactly the inputs the source reads', () => {
    expect(used.length).toBeGreaterThan(5);
    expect(root).toEqual(used);
  });

  it('has no api_key input in either manifest, the source or the README', () => {
    expect(root).not.toContain('api_key');
    expect(read('action/src/index.ts')).not.toMatch(/api_key/);
    expect(read('action/README.md')).not.toMatch(/^\| `api_key`/m);
  });

  it('documents every input in the README table', () => {
    const readme = read('action/README.md');
    for (const name of root) expect(readme, `README is missing ${name}`).toContain(`| \`${name}\``);
  });

  it('root manifest runs the committed bundle', () => {
    expect(read('action.yml')).toMatch(/main:\s*"action\/dist\/index\.js"/);
  });
});
