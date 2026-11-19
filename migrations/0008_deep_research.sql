-- Deep research (v0.9.8).
--
-- Add-only and revert-safe: two new columns, each with a default or allowing NULL, so older code (v0.9.7) that
-- doesn't know them keeps working after a revert. Nothing existing is changed or removed.
-- - user_usage_daily.research_runs: finished research runs per user per day (failed or stopped runs aren't counted).
-- - search_cache.checked_at: when a saved search was first made, so reused results show that date, not today.
--   NULL for rows saved by older code (shown as "date unknown").

ALTER TABLE user_usage_daily ADD COLUMN research_runs INTEGER NOT NULL DEFAULT 0;

ALTER TABLE search_cache ADD COLUMN checked_at INTEGER;
