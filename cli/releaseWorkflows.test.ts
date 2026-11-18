import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 9.6-REL: guards on the release and smoke workflows. The Marketplace publish
// is keyless (Trusted Publishing via OIDC) and gated by the `marketplace`
// environment; the smoke job needs no secrets at all.

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// The text of one job, from its key to the next two-space-indented job key.
function job(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('publish-extension.yml', () => {
  const yml = read('.github/workflows/publish-extension.yml');

  it('publishes only from a vscode-v* tag; dispatch only packages', () => {
    expect(yml).toMatch(/tags: \['vscode-v\*\.\*\.\*'\]/);
    for (const j of ['publish-marketplace', 'publish-openvsx']) {
      expect(job(yml, j)).toContain("if: startsWith(github.ref, 'refs/tags/vscode-v')");
    }
  });

  it('checks the tag against package.json', () => {
    expect(job(yml, 'package')).toContain('test "$want" = "$have"');
  });

  it('Marketplace publish is keyless: --oidc with id-token: write, no PAT', () => {
    const m = job(yml, 'publish-marketplace');
    expect(m).toContain('vsce publish --oidc');
    expect(m).toMatch(/id-token: write/);
    expect(yml).not.toMatch(/VSCE_PAT|AZURE_DEVOPS|secrets\.VSCE/);
    expect(m).not.toMatch(/secrets\./);
  });

  it('only the Marketplace job can mint an OIDC token', () => {
    const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code.match(/id-token: write/g)).toHaveLength(1);
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('both publish jobs wait for the marketplace environment', () => {
    for (const j of ['publish-marketplace', 'publish-openvsx']) expect(job(yml, j)).toContain('environment: marketplace');
    expect(job(yml, 'package')).not.toContain('environment:');
  });

  it('Open VSX uses OVSX_PAT only in its own job', () => {
    expect(job(yml, 'publish-openvsx')).toContain('OVSX_PAT: ${{ secrets.OVSX_PAT }}');
    expect(yml.match(/secrets\.OVSX_PAT/g)).toHaveLength(1);
  });

  it('the Open VSX token comes from the environment, never the command line', () => {
    const o = job(yml, 'publish-openvsx');
    expect(o).toContain('test -n "$OVSX_PAT"');
    expect(o).toMatch(/npx ovsx publish "[^"\n]+"\n/);
    expect(yml).not.toMatch(/(?:-p|--pat)\s+"?\$\{?OVSX_PAT/);
    expect(yml).not.toMatch(/ovsx publish[^\n]*(?:-p|--pat)\b/);
  });

  it('pins every third-party action to a full commit SHA with a version comment', () => {
    const uses = [...yml.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    for (const a of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact']) {
      expect(uses.some((u) => u.startsWith(`${a}@`)), a).toBe(true);
    }
  });

  it('the bundled extension is secret-scanned before upload', () => {
    expect(job(yml, 'package')).toContain('node scripts/check-bundle-secrets.mjs vscode-extension/dist');
  });
});

describe('smoke.yml', () => {
  const yml = read('.github/workflows/smoke.yml');

  it('runs daily and on demand, with no secrets', () => {
    expect(yml).toMatch(/schedule:\n\s+- cron: '[^']+'/);
    expect(yml).toContain('workflow_dispatch:');
    expect(yml).not.toMatch(/secrets\./);
    expect(yml).toContain('node scripts/smoke.mjs');
  });
});

describe('extension manifest', () => {
  const pkg = JSON.parse(read('vscode-extension/package.json'));

  it('uses the published SDK as a devDependency (esbuild inlines it)', () => {
    expect(pkg.devDependencies['@safesqlpro/sdk']).toMatch(/^\^0\.2\./);
    expect(pkg.dependencies?.['@safesqlpro/sdk']).toBeUndefined();
  });

  it('pins a vsce that supports --oidc, and ovsx', () => {
    expect(pkg.devDependencies['@vscode/vsce']).toMatch(/^\^4\.(1\.[1-9]|[2-9])/);
    expect(pkg.devDependencies.ovsx).toBeDefined();
  });

  it('publisher stays mpingosystems (the Open VSX namespace must match)', () => {
    expect(pkg.publisher).toBe('mpingosystems');
  });
});
