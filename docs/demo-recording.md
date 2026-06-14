# Demo GIF — Recording Sequence

For the Product Hunt gallery + HN post. Show the full catch→prove→fix loop.

## Sequence to record (~25 seconds of content, then loop)

1. Open `safesqlpro.dev/editor` — (2s)
2. Paste the schema DDL — (3s)
3. Click **Parse DDL** → show 3 tables loaded — (2s)
4. Paste the JOIN-multiplication query — (3s)
5. Click **Validate** → score drops to **54** + the fan-out warning — (3s)
6. Click **Run on synthetic data** → show the inflated row count — (5s)
7. Click **Apply fix** → query rewrites, score jumps to **92** — (3s)
8. Click **Copy link** → show the permalink URL — (2s)
9. Open the permalink in a new tab → read-only view — (2s)

Total ≈ 25 seconds. Loop it.

## Tooling

- **Windows:** ScreenToGif. **Mac:** CleanShot / Kap. Or Loom → export GIF.
- **Output:** `demo.gif`, **1200×750px**, **max 5MB** (trim frames / 15fps if over).
- Save to `docs/assets/demo.gif` and reference it from the PH gallery.

## Tips

- Use a clean browser window (no extensions bar, no bookmarks).
- Pre-load the schema + query in clipboard so paste is instant.
- Hide the cursor jitter; pause ~1s on the score change and the row-count reveal —
  those are the two "aha" frames.
