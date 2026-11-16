#!/usr/bin/env node
// Session state report. Prints (or writes) a one-page snapshot of where the
// project stands, built from git and from the private working-context folder.
//
//   node scripts/state.mjs --print   print to stdout, write nothing
//   node scripts/state.mjs --write   write the state file into the working-context folder
//
// The working-context folder comes from the SAFESQL_INTERNAL_DIR env var or a
// gitignored `.safesql-internal-path` file at the repo root (one line: the
// folder path). Its location never appears in a committed file. With neither
// set, --print shows a public-safe subset (version and git only) and says so.
//
// Files read from the working-context folder (all optional):
//   current-sprint.txt        lines "sprint: ...", "step: ...", "next: ..."
//   uncertainty-register.md   table: ID | Level | Item | Resolves when | Status
//   decision-log.md           table: Date | Code | Decision | Decided by
//   queue.md                  "## " sections of "- " items

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_NAME = ['STATE', 'md'].join('.');
const PATH_FILE = '.safesql-internal-path';

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function resolveInternalDir(root, env = process.env) {
  const fromEnv = env.SAFESQL_INTERNAL_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const f = join(root, PATH_FILE);
  if (existsSync(f)) {
    const p = readFileSync(f, 'utf8').trim();
    if (p) return resolve(p);
  }
  return null;
}

const readOpt = (dir, name) => {
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Rows of the first markdown table whose header row starts with `firstHeader`.
export function tableRows(md, firstHeader) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\|\\s*${firstHeader}\\s*\\|`).test(l));
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }
  return rows;
}

export function parseSprint(txt) {
  const out = {};
  for (const line of (txt ?? '').split(/\r?\n/)) {
    const m = line.match(/^(sprint|step|next):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function openRisks(md) {
  return tableRows(md, 'ID').filter(([, level = '', , , status = '']) => /^(critical|material)/i.test(level) && /^open/i.test(status));
}

export function queueSections(md) {
  const sections = [];
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+)/);
    if (h) sections.push({ title: h[1].trim(), items: [] });
    else if (line.startsWith('- ') && sections.length) sections.at(-1).items.push(line.slice(2).trim());
  }
  return sections;
}

function gitFacts(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)';
  const sha = git(root, ['rev-parse', '--short', 'HEAD']) || '(none)';
  const counts = git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  const [ahead, behind] = counts ? counts.split(/\s+/) : [];
  // Release tags only (vX.Y.Z); the moving major tag for the Action (v1) is not a release.
  const tag = git(root, ['tag', '--list', 'v[0-9]*', '--sort=-v:refname']).split('\n').find((t) => /^v\d+\.\d+\.\d+$/.test(t)) || '(none)';
  const log = git(root, ['log', '-5', '--format=%h %ad %s', '--date=short']);
  const dirty = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length;
  let version = '(unknown)';
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version;
  } catch {
    /* no package.json */
  }
  return { branch, sha, ahead, behind, upstream, tag, log, dirty, version };
}

export function renderState({ root, internalDir, now = new Date() }) {
  const g = gitFacts(root);
  const out = [];
  out.push('# SafeSQL Pro: state', '');
  out.push(`Generated: ${now.toISOString()} by scripts/state.mjs. Do not edit by hand.`, '');
  out.push(`- Version: ${g.version} (package.json) · latest tag ${g.tag}`);
  const sync = g.upstream ? `${g.ahead} ahead, ${g.behind} behind ${g.upstream} (as of last fetch)` : 'no upstream';
  out.push(`- ${g.branch} at ${g.sha} · ${sync} · ${g.dirty} uncommitted path(s)`);
  out.push('', '## Last 5 commits', '', ...(g.log ? g.log.split('\n').map((l) => `- ${l}`) : ['- (none)']));

  if (!internalDir) {
    out.push('', '_Working context not configured (set SAFESQL_INTERNAL_DIR or create the gitignored path file): public subset only._');
    return `${out.join('\n')}\n`;
  }

  const sprint = parseSprint(readOpt(internalDir, 'current-sprint.txt'));
  out.push('', '## Current sprint', '');
  out.push(`- Sprint: ${sprint.sprint ?? '(not set)'}`);
  out.push(`- Step: ${sprint.step ?? '(not set)'}`);
  out.push(`- **Next action:** ${sprint.next ?? '(not set)'}`);

  const reg = readOpt(internalDir, 'uncertainty-register.md');
  const risks = reg ? openRisks(reg) : [];
  out.push('', '## Open uncertainties (Critical / Material)', '');
  out.push(...(risks.length ? risks.map(([id, level, item]) => `- ${id} (${level.split(/\s/)[0]}): ${clip(item)}`) : ['- (none)']));

  const dec = readOpt(internalDir, 'decision-log.md');
  const rows = dec ? tableRows(dec, 'Date').slice(-5) : [];
  out.push('', '## Last 5 decisions', '');
  out.push(...(rows.length ? rows.map(([date, code, text, by]) => `- ${date}${code && code !== '—' ? ` ${code}` : ''}: ${clip(text)} (${by})`) : ['- (none)']));

  const q = readOpt(internalDir, 'queue.md');
  const sections = q ? queueSections(q) : [];
  out.push('', '## Queue', '');
  if (!sections.length) out.push('- (none)');
  for (const s of sections) {
    if (!s.items.length) continue;
    if (/^next/i.test(s.title)) out.push(`**${s.title}**`, ...s.items.map((i) => `- ${clip(i, 200)}`));
    else out.push(`**${s.title}:** ${s.items.map((i) => i.split(':')[0]).join(' → ')}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== '--print' && mode !== '--write') {
    console.error('usage: node scripts/state.mjs --print | --write');
    process.exit(2);
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']) || process.cwd();
  const internalDir = resolveInternalDir(root);
  if (internalDir && !existsSync(internalDir)) {
    console.error('state: the configured working-context folder does not exist');
    process.exit(1);
  }
  const text = renderState({ root, internalDir });
  if (mode === '--print') {
    process.stdout.write(text);
  } else {
    if (!internalDir) {
      console.error('state: --write needs SAFESQL_INTERNAL_DIR or the gitignored path file');
      process.exit(1);
    }
    writeFileSync(join(internalDir, OUT_NAME), text, 'utf8');
    console.log(`state: wrote ${OUT_NAME} (${text.split('\n').length} lines)`);
  }
}
