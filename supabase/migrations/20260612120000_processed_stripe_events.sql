-- Webhook event idempotency: claim an event before processing, complete
-- it on success, unclaim on thrown errors so Stripe can retry. Rows with
-- completed_at IS NULL and claimed_at older than 5 min are stale claims
-- from crashed Workers and may be safely reclaimed.
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     TEXT        PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ            -- NULL until handler succeeds
);

CREATE INDEX IF NOT EXISTS idx_pse_claimed_at
  ON processed_stripe_events (claimed_at);
CREATE INDEX IF NOT EXISTS idx_pse_completed_at
  ON processed_stripe_events (completed_at)
  WHERE completed_at IS NULL; -- partial index: fast scan for stale claims

REVOKE ALL ON processed_stripe_events FROM anon, authenticated;
