-- GitHub changes with the user's approval (v0.13.0).
--
-- Add-only and revert-safe: two new tables, one index and one counter column with a default. Nothing existing is
-- changed or removed, so older code (v0.12.x) keeps working after a revert (it never reads these).
-- - github_action_connections: one row per user who connected the separate VESPER "Actions" GitHub App (issues,
--   comments, pull requests). Same shape as github_connections; tokens stored ENCRYPTED with a different binding, so
--   a reading token and a changes token can't be swapped. Reading keeps using github_connections.
-- - github_actions: each change VESPER prepared. `payload` is exactly what will be sent to GitHub and `preview` what
--   the card shows; both are kept only while the card waits for a decision (at most 24 hours) and are cleared once it
--   is approved, rejected or expired. The row itself stays as the user's log (kind, repo, title, outcome, link) for
--   90 days. It goes when the user is deleted; deleting the chat keeps the log row (conversation_id becomes NULL).
-- - user_usage_daily.github_actions: approved changes per user per day (for the daily limit; admins are counted, not
--   limited).

CREATE TABLE IF NOT EXISTS github_action_connections (
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

CREATE TABLE IF NOT EXISTS github_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('issue', 'comment', 'pull_request')),
  repo            TEXT NOT NULL,
  title           TEXT NOT NULL,
  public_repo     INTEGER NOT NULL DEFAULT 0,
  warnings        TEXT NOT NULL DEFAULT '[]',       -- JSON array of plain-language cautions
  payload         TEXT,                             -- JSON; NULL once decided
  preview         TEXT,                             -- JSON; NULL once decided
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'failed', 'rejected', 'expired')),
  result_url      TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_github_actions_user_created ON github_actions (user_id, created_at DESC);

ALTER TABLE user_usage_daily ADD COLUMN github_actions INTEGER NOT NULL DEFAULT 0;
