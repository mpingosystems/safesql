# CLAUDE.md

Conventions for working on this repository with Claude Code.

## Start of every session

```powershell
node C:\path\to\safesql\scripts\state.mjs --print
```

It prints version, branch, sync with origin and recent commits. If a working-context folder is configured locally (env var `SAFESQL_INTERNAL_DIR`, or the gitignored `.safesql-internal-path` file), it also prints the current sprint, next action, open risks and recent decisions. Never commit that file or its path.

## Tests (the commit gate)

- `npm test`: vitest, the whole suite. Gate commits on its own exit code.
- `python -m pytest -q` in `dbt-safesql/`: the Python package.
- `npm run check:leaks`: fails if a tracked file refers to private working context. Output names file and line only.
- `npm run build`: typecheck + bundle; `postbuild` runs the bundle secret scan and must report `0 findings`.

`npm run lint` has pre-existing `no-explicit-any` errors; it is not a gate.

## Detection rules

- Detection is deterministic: node-sql-parser AST → detectors. AI never decides whether a rule fires; it only explains findings, and everything works without it.
- Score policy: hard errors 0–40, high-risk warnings 41–69, medium warnings 70–84, suggestions 85–100, clean 95–100. Verdicts come from `verdictFor()` in `src/services/fileValidation.ts` (RISKY < 50 · REVIEW < 85 · SAFE ≥ 85). A fixed query must always score higher than its flawed original.
- Every detector returns the full issue contract (`ValidationIssue` in `src/types/validation.ts`): `issueType`, `severity` (`error` | `warning` | `suggestion`), `offendingClause`, `offendingTable`, `offendingColumn` where they apply, a `message` naming the clause, a concrete SQL `fix`, and a negative `scoreImpact`.
- Product claims follow code: every claim on a public page maps to a shipped route (`cli/tierClaims.test.ts`).

## Cloudflare Pages Functions

- No Node SDKs in Functions (Stripe, Anthropic and the rest go through `fetch()`); Node built-ins such as `Buffer` crash Workers.
- Functions cannot import browser modules that read `import.meta.env`.
- Never hardcode domains: use `SITE_URL` server-side and `apiUrl()` in the browser.

## Secrets

- Never print, log or read secret values, including `.env.local` and `.env.production`. Count matches (`grep -c`) instead.
- Never put a secret in a `VITE_` variable: they are baked into the public bundle at build time, and Vite loads `.env.local` for production builds too.
- Never commit `.env.local` or `.env.production`.
- Never log SQL text, prompts or result rows to the audit chain; hashes only.

## Database

- Migrations live in `supabase/migrations/`. Writing one does not apply it; never assume a migration is applied.
- RLS identifies the user with `auth.jwt()->>'sub'`, never `current_setting(...)`.

## Deploy

```powershell
npm --prefix C:\path\to\safesql run build
wrangler pages deploy C:\path\to\safesql\dist --project-name safesql --branch main --commit-dirty=true
```

Then check: a new chunk hash is served, `index.html` is still `no-cache, must-revalidate`, new routes return 200, and new authenticated endpoints return 401 without credentials.

## Windows

PowerShell with absolute paths; write files as UTF-8 without BOM.
