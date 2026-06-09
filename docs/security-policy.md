# Information Security Policy

*Mpingo Systems LLC — SafeSQL Pro · Effective June 8, 2026 · Internal*

This policy defines how Mpingo Systems LLC protects the confidentiality, integrity, and
availability of SafeSQL Pro and the data it processes. It is the internal counterpart to the
public Security page (safesqlpro.dev/security).

## 1. Access control

- **Least privilege.** Access to production systems (Cloudflare, Supabase, Stripe, Clerk) is
  granted only to personnel who require it for their role, and only at the minimum scope needed.
- **Authentication.** All admin accounts require multi-factor authentication. Shared logins are
  prohibited.
- **Secrets.** Production secrets (`SCHEMA_ENCRYPTION_KEY`, Supabase service-role key, Stripe
  secret key) live only in Cloudflare Workers/Pages encrypted environment variables. They are
  never committed to git, never pasted into chat tools, and never stored in plaintext at rest.
- **Review cadence.** Access lists are reviewed quarterly and immediately on any role change.

## 2. Data classification

| Class | Examples | Handling |
|-------|----------|----------|
| **Restricted** | DB connection strings, encryption key, service-role key, API key material | Encrypted at rest (AES-256-GCM) or hashed (SHA-256). Decryption only inside the Worker. Never logged. |
| **Confidential** | User email/name, SQL queries, DDL schemas, validation history | RLS-isolated per user/team. Raw SQL not stored beyond validation history needs. |
| **Internal** | Usage analytics, aggregate metrics | Restricted to authorized staff. |
| **Public** | Marketing copy, blog, shared validation permalinks | No PII; permalinks expire in 30 days. |

## 3. Incident response procedure

See `docs/incident-response-plan.md` for the full step-by-step. Summary: Detect → Contain →
Assess → Notify (users within 72h) → Remediate → Post-incident report within 30 days.

## 4. Change management

- All code changes land via pull request to `main`; no direct pushes to production logic without review.
- The automated test suite (`npm test`, Vitest) must pass before merge; the deterministic detector
  baseline must not regress.
- Builds are reproducible (`npm run build`) and deployed via `wrangler pages deploy`.
- Database schema changes are delivered as versioned SQL migrations under `supabase/migrations/`
  and applied through the Supabase SQL editor with verification queries.
- Dependency updates are reviewed for known vulnerabilities before merge.

## 5. Employee / contractor offboarding

On departure of any person with system access:
1. Revoke Cloudflare, Supabase, Stripe, Clerk, and GitHub access within 24 hours.
2. Rotate any shared or potentially exposed secrets (`SCHEMA_ENCRYPTION_KEY`, service-role key).
3. Remove from internal communication channels and email aliases.
4. Confirm no personal devices retain production credentials.
5. Record the offboarding in the access-review log.

## 6. Review

This policy is reviewed at least annually and after any material change to infrastructure,
sub-processors, or a security incident.
