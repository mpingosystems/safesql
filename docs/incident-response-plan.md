# Incident Response Plan

*Mpingo Systems LLC — SafeSQL Pro · Effective June 8, 2026 · Internal*

This plan defines the steps taken when a security incident affecting SafeSQL Pro is suspected or
confirmed. It supports the public commitments on the Security page (72-hour user notification,
30-day post-incident report).

## Roles

- **Incident Lead** — coordinates the response, owns the decision to notify. (Founder by default.)
- **Technical Responder** — performs containment and remediation.
- **Communications** — drafts user and authority notifications.

(In a small team one person may hold multiple roles; the Incident Lead is always named per incident.)

## Step 1 — Detection

Triggers include: monitoring/alerting (Cloudflare, Supabase), an error spike, a user report, or a
responsible-disclosure email to security@safesqlpro.dev. Log the date/time of first awareness — the
72-hour notification clock starts here.

## Step 2 — Containment

Immediately limit the blast radius:
- Disable the affected feature, route, or endpoint.
- Revoke or rotate compromised credentials (`SCHEMA_ENCRYPTION_KEY`, service-role key, API keys).
- If an individual API key is implicated, revoke that key; if user data isolation is in question,
  consider temporarily disabling the affected table's access.

## Step 3 — Assessment

Determine: what happened, the root cause, which data categories were affected (see
`docs/data-retention-policy.md` for classes), how many users, and whether the incident is ongoing or
contained. Preserve logs and evidence for the post-incident report.

## Step 4 — Notification

- **Users:** notify affected users within **72 hours** of confirming a breach, by email, with what
  happened, what data was involved, and what they should do.
- **Authorities:** notify relevant supervisory authorities (e.g. EU/UK GDPR regulators) where
  required by law, within applicable deadlines.
- **Sub-processor incidents:** if the incident originates with a sub-processor (Clerk, Supabase,
  Cloudflare, Stripe, Resend, Anthropic), coordinate notifications with their disclosure.

## Step 5 — Remediation

Develop and ship the fix via the standard change-management flow (PR → tests pass → deploy). Verify
the fix in production and confirm the vulnerability is closed. Rotate any remaining at-risk secrets.

## Step 6 — Post-incident report

Within **30 days**, publish a post-incident report covering: timeline, root cause, impact,
remediation, and preventive measures. Update internal policies and this plan with lessons learned.

## Contacts

- Security reports: security@safesqlpro.dev
- Privacy/data-subject: privacy@safesqlpro.dev
