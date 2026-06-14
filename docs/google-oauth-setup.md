# Google OAuth — Production Setup (Clerk)

Google sign-in fails on `safesqlpro.dev` with:

> Access blocked: Authorization Error — Missing required parameter: `client_id`

Cause: Google OAuth credentials are not configured for the **production** Clerk
instance. This is a dashboard task (cannot be done in code). Follow the steps below.

---

## STEP 1 — Google Cloud Console

`console.cloud.google.com` → your project → **APIs & Services → Credentials**
→ **Create Credentials → OAuth 2.0 Client ID**

- **Application type:** Web application
- **Name:** SafeSQL Pro Production

**Authorized JavaScript origins:**
```
https://safesqlpro.dev
https://clerk.safesqlpro.dev
```

**Authorized redirect URIs:**
```
https://clerk.safesqlpro.dev/v1/oauth_callback
```

→ **Create** → copy the **Client ID** and **Client Secret**.

> If the OAuth consent screen isn't configured yet, set it up first
> (External user type, app name "SafeSQL Pro", support email, and add the
> `.../auth/userinfo.email` + `.../auth/userinfo.profile` scopes).

---

## STEP 2 — Clerk Dashboard

`clerk.com` → **SafeSQL → Production → Configure**
→ **User & Authentication → Social connections → Google**
→ **Enable** → toggle **"Use custom credentials"** → paste the **Client ID** and
**Client Secret** from Step 1 → **Save**.

---

## STEP 3 — Verify

1. Open `https://safesqlpro.dev` → **Sign in** → **Continue with Google**.
2. It should complete without the "Authorization Error".
3. After verifying, remove the temporary in-app notice (see below).

---

## In-app temporary notice (code)

While Google is not yet configured, the sign-in surface shows a friendly hint so
users aren't confused by a blank Google error:

> "Google sign-in is being configured — please use email sign-in for now."

This lives in `src/components/AuthControls.tsx` behind the `googleNotice` prop.
**Once Step 3 passes, remove the `googleNotice` usage** (or set it to `false`).
