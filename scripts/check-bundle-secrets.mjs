#!/usr/bin/env node
// Bundle secret guard (9.6-SEC). Runs as `postbuild`: scans every file under
// dist/ and exits 1 if any secret pattern is present. A VITE_ variable is baked
// into the public bundle, and Vite loads .env.local for production builds too,
// so this is the last line of defence before `wrangler pages deploy dist`.
//
// Output names the file and the pattern TYPE only. It never prints the matched
// text, so a failing build log can't leak the secret it caught.
//
// Usage: node scripts/check-bundle-secrets.mjs [dir]   (default: dist)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// base64 of "service_role", as aligned at a 3-byte boundary of a JWT payload.
const SERVICE_ROLE_B64 = 'c2VydmljZV9yb2xl';

// The Anthropic prefix is written with a character class ([t]) so the literal
// key prefix never appears in a committed file. That keeps the history check
// (`git log -S` on the prefix) at zero.
export const PATTERNS = [
  { type: 'anthropic_api_key', re: /sk-an[t]-[A-Za-z0-9_-]{20,}/ },
  // Lookbehind so a SafeSQL `ssk_live_` key isn't double-reported as Stripe.
  { type: 'stripe_secret_key', re: /(?<![A-Za-z0-9_])sk_live_[A-Za-z0-9]{10,}/ },
  { type: 'stripe_restricted_key', re: /(?<![A-Za-z0-9_])rk_live_[A-Za-z0-9]{10,}/ },
  // SafeSQL keys are ssk_live_ + nanoid(32), and nanoid uses '_' and '-'.
  { type: 'safesql_api_key', re: /ssk_live_[A-Za-z0-9_-]{10,}/ },
];

const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;

function decodeB64Url(s) {
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// A Supabase service-role key is a JWT whose payload says role=service_role.
// The aligned base64 substring catches it cheaply. Decoding the payload catches
// it at any alignment.
function hasServiceRoleJwt(text) {
  for (const m of text.matchAll(JWT_RE)) {
    const payload = m[1];
    if (payload.includes(SERVICE_ROLE_B64)) return true;
    if (/"role"\s*:\s*"service_role"/.test(decodeB64Url(payload))) return true;
  }
  return false;
}

export function scanText(text) {
  const types = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.type);
  if (hasServiceRoleJwt(text)) types.push('supabase_service_role_jwt');
  return types;
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// Returns { files, findings: [{ file, type }] }. Never returns matched text.
export function scanDir(dir) {
  const root = resolve(dir);
  const files = listFiles(root);
  const findings = [];
  for (const f of files) {
    // latin1 maps every byte to one char, so binary files can't throw and the
    // ASCII-only patterns still match.
    const text = readFileSync(f, 'latin1');
    for (const type of scanText(text)) findings.push({ file: relative(root, f).replace(/\\/g, '/'), type });
  }
  return { files: files.length, findings };
}

export function formatReport({ files, findings }) {
  if (findings.length === 0) return `secret scan: ${files} files, 0 findings`;
  const lines = findings.map((f) => `secret scan: FOUND ${f.type} in ${f.file}`);
  lines.push(`secret scan: ${files} files, ${findings.length} findings. Build FAILED: remove the secret from the bundle (never use a VITE_ variable for a secret).`);
  return lines.join('\n');
}

function main() {
  const dir = process.argv[2] ?? 'dist';
  let result;
  try {
    result = scanDir(dir);
  } catch (e) {
    console.error(`secret scan: cannot read ${dir} (${e?.code ?? 'error'})`);
    process.exit(1);
  }
  const report = formatReport(result);
  if (result.findings.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
