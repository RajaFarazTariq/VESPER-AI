-- Proactive VESPER (v0.18.0): reminders, a daily briefing and meeting alerts as Web Push notifications.
--
-- Add-only and revert-safe: five new tables and their indexes. Nothing existing is changed or removed, so older code
-- (v0.17.x) keeps working after a revert (it never reads these).
-- - push_keys: VESPER's own VAPID key pair (ECDSA P-256, one row, made automatically on first use). Push services
--   accept notifications for a subscription only when they are signed with the key the browser subscribed with.
--   `subject` is the app's origin (sent with each notification as the contact), saved from the latest request.
-- - push_subscriptions: each browser where the user switched notifications on (endpoint = the push service address,
--   p256dh/auth = the browser's keys that encrypt the content). Removed when the push service says it is gone, or after
--   5 failures in a row, and with the user.
-- - notification_prefs: one row per user: their time zone (from the browser), the daily briefing (on/off, minute of the
--   day, default 22:00; last_briefing_day = the local day the last one was about, so each day gets one) and meeting
--   alerts (on/off, minutes before; the calendar is read again 5 minutes after meeting_checked_at).
-- - reminders: "remind me at 5 PM to call Ali". Sent once (status pending → sent) or cancelled; kept 30 days after.
--   When no device took it (push services failing), it goes back to pending: at most 2 more tries, within 15 minutes.
--   Deleting the chat keeps the reminder (conversation_id becomes NULL); deleting the user deletes everything.
-- - meeting_alerts_sent: which calendar events were already announced (event id + start), cleaned after 2 days.

CREATE TABLE IF NOT EXISTS push_keys (
  id          TEXT PRIMARY KEY,                -- always 'vapid'
  public_jwk  TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  subject     TEXT,                            -- the app's origin, e.g. https://ai-assistant.example.workers.dev
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,                    -- base64url, the browser's P-256 public key
  auth       TEXT NOT NULL,                    -- base64url, 16 bytes
  label      TEXT NOT NULL DEFAULT '',         -- e.g. "Chrome on Windows"
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone          TEXT NOT NULL DEFAULT 'UTC',
  briefing_enabled   INTEGER NOT NULL DEFAULT 1,
  briefing_minute    INTEGER NOT NULL DEFAULT 1320 CHECK (briefing_minute BETWEEN 0 AND 1439),
  last_briefing_day  TEXT,                     -- YYYY-MM-DD, local: the day the last briefing was about
  meeting_alerts     INTEGER NOT NULL DEFAULT 1,
  meeting_minutes    INTEGER NOT NULL DEFAULT 10,
  meeting_checked_at INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  text            TEXT NOT NULL,
  due_at          INTEGER NOT NULL,
  time_zone       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0     -- sends that reached no device (tried again up to 2 times)
);

CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders (status, due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders (user_id, status, due_at);

CREATE TABLE IF NOT EXISTS meeting_alerts_sent (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_key)
);
