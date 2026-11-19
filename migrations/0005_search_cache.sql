-- Web search cache (v0.9.5): the same search within a short time (1 hour for "latest"/news questions, 6 hours
-- otherwise) reuses the saved results instead of spending another free Tavily search.
--
-- Add-only migration: one new table and its index. Nothing existing is changed. Rows hold public search results
-- only (no user or conversation data) and expire; the daily cron deletes expired rows.

CREATE TABLE IF NOT EXISTS search_cache (
  key        TEXT PRIMARY KEY,    -- SHA-256 of the normalised request (query, topic, site filters)
  body       TEXT NOT NULL,       -- the results as the search service returned them (JSON)
  expires_at INTEGER NOT NULL     -- milliseconds since the epoch
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache (expires_at);
