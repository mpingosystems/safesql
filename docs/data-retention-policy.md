# Data Retention Policy

*Mpingo Systems LLC — SafeSQL Pro · Effective June 8, 2026 · Internal*

This schedule defines how long each category of data is retained and matches the public Privacy
Policy (safesqlpro.dev/privacy). Data is deleted or anonymized at the end of its retention period
unless a longer period is required by law.

## Retention schedule

| Data category | Retention period | Notes |
|---------------|------------------|-------|
| **Account data** (email, name, plan) | Active account lifetime | Deleted within 30 days of account deletion request. |
| **Validation history** | 12 months (Free tier); unlimited (paid tiers) | Free-tier records older than 12 months are purged automatically. |
| **Shared validation permalinks** | 30 days | Expire and become inaccessible; rows purged by cleanup job. |
| **Database connection credentials** | 7 days post-deletion | Deleted within 7 days of connection removal or account deletion. Stored AES-256-GCM encrypted while active. |
| **Log data** (IP, browser, timestamps) | 90 days | Rolling deletion. |
| **Payment records** (Stripe customer/subscription IDs, invoices) | 7 years | Retained to meet tax and accounting requirements. |
| **Audit log** (Business/Enterprise) | Retained per contract; minimum account lifetime | Append-only; exportable as CSV. |

## Deletion mechanics

- **Automated purges.** Validation history (Free), permalinks, logs, and removed connection
  credentials are purged by scheduled jobs at the cadence above.
- **On request.** A verified deletion request (privacy@safesqlpro.dev) triggers removal of account
  data, validation history, saved queries, and connection credentials within 30 days, except data
  we are legally required to retain (e.g. payment records for tax).
- **Backups.** Backups are retained on a rolling 30-day window; deleted data ages out of backups
  within that window.

## Legal holds

If data is subject to a legal hold or active investigation, retention is extended for the duration
of the hold regardless of the schedule above.

## Review

Reviewed annually and whenever the Privacy Policy retention terms change.
