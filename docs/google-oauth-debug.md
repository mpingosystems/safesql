# Google OAuth — Debugging `authorization_invalid`

Symptom: `GET clerk.safesqlpro.dev/v1/oauth_callback?err_code=authorization_invalid`
(Clerk returns 403). Identity Toolkit API enabled, consent screen published
(External), redirect URI set — but sign-in still fails. Work the steps in order.

Quick check first: `GET https://safesql.pages.dev/api/auth/google-test` →
`{ clerk_domain, has_clerk_secret, timestamp }`. `clerk_domain` must be
`clerk.safesqlpro.dev` and `has_clerk_secret` must be `true`.

---

## Step 1 — Verify the Google OAuth client settings
`console.cloud.google.com` → APIs & Services → Credentials → your OAuth 2.0 client.

**Authorized JavaScript origins** MUST include (exactly, no trailing slash):
```
https://safesqlpro.dev
https://clerk.safesqlpro.dev
```
**Authorized redirect URIs** MUST include:
```
https://clerk.safesqlpro.dev/v1/oauth_callback
```
A missing/typo'd redirect URI is the most common cause of `authorization_invalid`.

## Step 2 — Verify the Clerk SSO connection
Clerk → **Production** → SSO connections → Google:
- **Client ID** ends in `.apps.googleusercontent.com`
- **Client Secret** starts with `GOCSPX-`
- **Status** = Enabled
- Ensure "Use custom credentials" is ON (not Clerk's shared dev credentials).

## Step 3 — Check Clerk logs
Clerk → Production → **Logs** → filter `oauth`. Find the entry right after
`sign_in.created` — it states the precise reason (bad redirect, scope, client mismatch).

## Step 4 — Try a different Google account
The first account tried can get cached in a bad state. Test with a completely
different Google account (and/or an incognito window).

## Step 5 — Re-create the Google OAuth client
If Steps 1–4 are all correct, delete and recreate the OAuth client in Google Cloud
(clients occasionally land in a bad state), re-paste the new Client ID/Secret into
Clerk (Step 2), and re-test.

---

When fixed: remove the `googleNotice` from the landing nav `AuthControls`, and the
`OAuthErrorNotice` will stop firing (no `authorization_invalid` in the URL).
