-- GitHub (read-only) per user (v0.12.0).
--
-- Add-only and revert-safe: two new tables and one index. Nothing existing is changed or removed, so older code
-- (v0.11.0) keeps working after a revert (it simply never reads these tables).
-- - github_connections: one row per user who connected GitHub through the VESPER GitHub App. The access and refresh
--   tokens are stored ENCRYPTED (AES-GCM, key in the GITHUB_TOKEN_KEY secret, bound to the user id). status
--   'reconnect' = GitHub said the access was removed or expired; the user sees "Reconnect GitHub".
--   refreshing_until: a short lock so only one token renewal per user runs at a time (GitHub's refresh tokens work once).
-- - github_cache: a short cache of GitHub API responses per user (at most 15 minutes; removed on disconnect, on the
--   next request after expiry and by the daily clean-up). The ETag lets an unchanged answer come back as
--   "304 Not Modified", which doesn't use the user's GitHub allowance.
-- Both tables go when the user is deleted.

CREATE TABLE IF NOT EXISTS github_connections (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_id          INTEGER NOT NULL,
  login              TEXT NOT NULL,
  access_token       TEXT NOT NULL,                 -- encrypted
  access_expires_at  INTEGER NOT NULL,
  refresh_token      TEXT,                          -- encrypted; NULL when GitHub gave none
  refresh_expires_at INTEGER,
  status             TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect')),
  refreshing_until   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS github_cache (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                        -- sha-256 of the request
  etag        TEXT,
  body        TEXT NOT NULL,
  fresh_until INTEGER NOT NULL,                     -- reused without asking GitHub until then
  expires_at  INTEGER NOT NULL,                     -- deleted after this (15 minutes after it was fetched)
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_github_cache_expires ON github_cache (expires_at);
