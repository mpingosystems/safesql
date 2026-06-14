# CI/CD Demo — SafeSQL Pro GitHub Action

Proves the SafeSQL Pro GitHub Action (`mpingosystems/safesql@v1`) blocks bad SQL
in CI. Doubles as a linkable demo for Product Hunt / HN ("here's a PR where
SafeSQL Pro caught a JOIN-multiplication bug").

## Files

- `.github/workflows/validate-sql.yml` — runs on push/PR touching `test-queries/**/*.sql`.
- `test-queries/schema.sql` — `users` + `orders` schema.
- `test-queries/should-fail.sql` — JOIN-multiplication (self-join `users u2`) → must FAIL.
- `test-queries/should-pass.sql` — clean `LEFT JOIN` + `COUNT(DISTINCT)` → must PASS.
- `action/dist/index.js` — rebuilt via `npx @vercel/ncc build src/index.ts -o dist` (current engine).

## Expected workflow result

| File | Detector | CI result |
|---|---|---|
| `should-fail.sql` | `AGGREGATE_OVER_FANOUT_JOIN` (SUM over a fan-out self-join) | ❌ Action exits 1 → check fails |
| `should-pass.sql` | none (clean) | ✅ Action exits 0 → check passes |

On a PR, the Action posts a summary comment (file · score · issues) and fails the
check when any file scores below the configured threshold.

## How to verify

1. Push these files (already on `main`) or open a PR editing a `test-queries/*.sql`.
2. **GitHub → Actions** tab → "SafeSQL Pro — Validate SQL" run.
3. Confirm: `should-fail.sql` fails the job; `should-pass.sql` passes; PR shows the summary comment.

## ⚠️ Release caveat (important)

The workflow pins `mpingosystems/safesql@v1`, which is the **published `v1` git tag**,
not `main`. The dist rebuilt this sprint is committed to `main` but the live
Action only uses the current engine once the `v1` tag is re-pointed:

```bash
# After committing the rebuilt action/dist on main:
git tag -f v1 && git push origin v1 --force          # re-point the major tag
# (or publish a new release and bump the workflow to @v1.x)
```

Until `v1` is re-tagged, CI runs the engine bundled at the existing `v1` tag.
Re-tagging is a release action — left for the maintainer to run intentionally.
