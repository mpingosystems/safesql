#!/usr/bin/env node
// Leak guard. Fails if a tracked file (or a tracked or untracked path name)
// refers to the project's private working context: internal folder names,
// internal document names, or local machine paths.
//
// The denylist is stored as SHA-256 hashes of normalised terms, so this public
// script never spells the terms out. Matching works on tokens: text is
// lowercased, runs of backslashes become '/', and it is split into letter runs,
// digit runs and single punctuation characters. Every run of up to MAX_NGRAM
// adjacent tokens (no whitespace between them) is hashed and looked up.
//
// Output names the file and line, never the matched text.
//
// Usage: node scripts/check-leaks.mjs [repoDir]   (default: current directory)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// sha256(normalised term), one per denylist term.
const TERM_HASHES = new Set([
  'bd9b8a35b63849a7fe1a4ac1b6870ee5af829ef8d4a421a099b65cd10ddb6edb',
  '7c56042e01cea433a9a9a405e474a9a6714ff00b9fef7c4b95595f986d4dc325',
  '3b1445640016e175ac4726662ebe4a8674f04966d3885c788cd459e7874deb26',
  'ff64df41fe954214a939b5b8eab83b9cfc0233350dde38e3f23a2ae95cbbc86a',
  '8afab5019ed2adb3c4abbcc1013e64aba6fa8fe61c224e62bf28a729131c544c',
  'a5f2fccfdc7de8fc64fa546d73da7d45d96495026b75f72cf5c557c423e0a696',
  '4bf3d155bf7a4cf254bbe4a03f780744a9aed8e30abe9d7fa59a70a9425a2240',
  'c4826b9ac432cd40f41d6cd42f95c7878bc022526217eea2eae1f1e9ceb91d82',
  '472724133ab0361a0007de6864f0a8f8f8b54cd9b796195e6a2f8cc18b0d6609',
]);

// sha256 of each term's first token: a cheap filter so only plausible starts
// are extended into n-grams.
const FIRST_TOKEN_HASHES = new Set([
  '8ce7b776ce0bc98da9f967bc0fe06f7bec3894dbe3ee5556a2f3750e7607619a',
  '32e83e92d45d71f69dcf9d214688f0375542108631b45d344e5df2eb91c11566',
  '4ba69735ca53765ed6a709edb56c6ea236b7193a3b29a6b390c346f0f4340e4e',
  'b786c9d1e1f69fc8b0b3d4e8fb9ca00ef6097cfcd522c036e04c30ebef237ece',
  'c97550ce8213ef5cf6ed4ba48790c137df3ef6a5da20b48961001a634b6cead2',
  '2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6',
  '7dfb4cf67742cb0660305e56ef816c53fcec892cae7f6ee39b75f34e659d672c',
]);

const MAX_NGRAM = 8;
const TOKEN_RE = /[a-z]+|[0-9]+|[^a-z0-9\s]/g;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const firstCache = new Map();
function isFirstToken(tok) {
  let hit = firstCache.get(tok);
  if (hit === undefined) {
    hit = FIRST_TOKEN_HASHES.has(sha256(tok));
    firstCache.set(tok, hit);
  }
  return hit;
}

export function normalise(text) {
  return text.toLowerCase().replace(/\\+/g, '/');
}

// True if the line contains a denylisted term.
export function lineHasTerm(line) {
  const toks = [...normalise(line).matchAll(TOKEN_RE)].map((m) => ({ t: m[0], start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < toks.length; i++) {
    if (!isFirstToken(toks[i].t)) continue;
    let gram = toks[i].t;
    if (TERM_HASHES.has(sha256(gram))) return true;
    for (let j = i + 1; j < toks.length && j - i < MAX_NGRAM; j++) {
      if (toks[j].start !== toks[j - 1].end) break; // whitespace or a gap ends the run
      gram += toks[j].t;
      if (TERM_HASHES.has(sha256(gram))) return true;
    }
  }
  return false;
}

// Returns line numbers (1-based) that contain a term.
export function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (lineHasTerm(lines[i])) hits.push(i + 1);
  return hits;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Returns { files, findings: [{ file, line, kind }] }. Never returns matched text.
// kind: 'content' (a line in a tracked file) or 'path' (a tracked or
// untracked-not-ignored path name, which also catches a private working-context
// folder created inside the repo).
export function scanRepo(dir) {
  const root = resolve(dir);
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const findings = [];
  for (const p of [...tracked, ...untracked]) {
    if (lineHasTerm(p)) findings.push({ file: p, line: 0, kind: 'path' });
  }
  for (const f of tracked) {
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    for (const line of scanText(buf.toString('utf8'))) findings.push({ file: f, line, kind: 'content' });
  }
  return { files: tracked.length, findings };
}

export function formatReport({ files, findings }) {
  const out = findings.map((f) =>
    f.kind === 'path' ? `  ${f.file}: path names private working context` : `  ${f.file}:${f.line}: refers to private working context`,
  );
  out.push(`leak check: ${files} files, ${findings.length} findings`);
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scanRepo(process.argv[2] ?? process.cwd());
  const report = formatReport(result);
  if (result.findings.length) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}
