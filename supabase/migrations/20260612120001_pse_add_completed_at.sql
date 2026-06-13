-- Addendum to 20260612120000_processed_stripe_events.sql
-- Apply ONLY if that migration was already run against this environment
-- with the original schema (processed_at column, no completed_at).
-- On a fresh DB, 20260612120000 already includes these columns — skip this.
--
-- Safe to run multiple times: all statements use IF NOT EXISTS / IF EXISTS.

-- 1. Rename processed_at → claimed_at (reflects that the row is "claimed"
--    before processing starts, not after it completes).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'processed_stripe_events'
      AND column_name = 'processed_at'
  ) THEN
    ALTER TABLE processed_stripe_events
      RENAME COLUMN processed_at TO claimed_at;
  END IF;
END $$;

-- 2. Add completed_at — NULL until the handler finishes successfully.
--    A row with completed_at IS NULL and claimed_at older than 5 min
--    is a stale claim from a crashed Worker and can be reclaimed.
ALTER TABLE processed_stripe_events
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 3. Replace the old processed_at index with claimed_at + partial index.
DROP INDEX IF EXISTS idx_pse_processed_at;

CREATE INDEX IF NOT EXISTS idx_pse_claimed_at
  ON processed_stripe_events (claimed_at);

CREATE INDEX IF NOT EXISTS idx_pse_completed_at
  ON processed_stripe_events (completed_at)
  WHERE completed_at IS NULL;
