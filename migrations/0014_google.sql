-- Google Calendar and Gmail with the user's approval (v0.15.0).
--
-- Add-only and revert-safe: two new tables, one index and two counter columns with defaults. Nothing existing is
-- changed or removed, so older code (v0.14.x) keeps working after a revert (it never reads these).
-- - google_connections: one row per user who connected Google (separate from "Continue with Google" sign-in).
--   `scopes` is what the user allowed on Google's screen (Calendar events and/or sending email); tokens are stored
--   ENCRYPTED (lib/secret-box, key GOOGLE_TOKEN_KEY, bound to the user). status 'reconnect': Google ended the access
--   (it does so after 7 days while the Google app is in testing, or when the user removes it).
-- - google_actions: each email or calendar event VESPER prepared. `payload` is exactly what will be sent; it is kept
--   only while the card waits for a decision (at most 24 hours) and cleared once it is approved, rejected or expired.
--   The row itself stays as the user's log (kind, subject or event title, recipients or time, outcome, link) for 90
--   days. It goes when the user is deleted; deleting the chat keeps the log row (conversation_id becomes NULL).
-- - user_usage_daily.emails / .events: approved emails sent and events added per user per day (for the daily limits;
--   admins are counted, not limited).

CREATE TABLE IF NOT EXISTS google_connections (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub        TEXT NOT NULL,
  email             TEXT NOT NULL,
  scopes            TEXT NOT NULL,                 -- space-separated, as Google granted them
  access_token      TEXT NOT NULL,                 -- encrypted
  access_expires_at INTEGER NOT NULL,
  refresh_token     TEXT NOT NULL,                 -- encrypted
  status            TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS google_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('email', 'event')),
  title           TEXT NOT NULL,                   -- the email's subject or the event's title
  target          TEXT NOT NULL,                   -- who it goes to, or when the event is
  warnings        TEXT NOT NULL DEFAULT '[]',      -- JSON array of plain-language cautions
  payload         TEXT,                            -- JSON; NULL once decided
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'failed', 'rejected', 'expired')),
  result_url      TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_google_actions_user_created ON google_actions (user_id, created_at DESC);

ALTER TABLE user_usage_daily ADD COLUMN emails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_usage_daily ADD COLUMN events INTEGER NOT NULL DEFAULT 0;
