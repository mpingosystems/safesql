# Email Digest — Cron Worker Setup

Cloudflare Pages can't run `[triggers]` (cron), so the weekly digest is fired by a
**standalone Worker** in `workers/digest-cron/` that POSTs the Pages digest
endpoint on a schedule.

## How it works
```
safesql-digest-cron Worker  ──(Mon 09:00 UTC)──▶  POST https://safesql.pages.dev/api/digest/send
   (cron "0 9 * * 1")            x-cron-secret: <DIGEST_CRON_SECRET>
                                         │
                                         ▼  endpoint verifies the secret, then
                                            sends each due user's weekly digest via Resend
```

## Deploy (manual — needs wrangler auth)
```powershell
cd workers/digest-cron
npm install
wrangler secret put DIGEST_CRON_SECRET   # paste a strong random value
wrangler deploy
```

## Pages side (so the endpoint accepts the cron)
Set the **same** value in Cloudflare Pages → safesql → Settings → Environment variables:
```
DIGEST_CRON_SECRET = <same value as the Worker secret>
```
`/api/digest/send` checks `DIGEST_CRON_SECRET` (falls back to the legacy `CRON_SECRET`).
Also ensure `RESEND_API_KEY` + `RESEND_FROM` are set for emails to actually send.

## Verify
- `wrangler deployments list` shows `safesql-digest-cron`.
- Trigger once: `wrangler dev --test-scheduled` then `curl "http://localhost:8787/__scheduled?cron=0+9+*+*+1"`.
- Or wait for Monday 09:00 UTC and check the Worker logs (`wrangler tail`).

## Change the schedule
Edit `crons` in `workers/digest-cron/wrangler.toml` (e.g. `"0 9 * * *"` for daily),
then `wrangler deploy`.
