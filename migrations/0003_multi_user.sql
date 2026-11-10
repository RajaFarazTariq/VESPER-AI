-- Phase 6.0: multi-user accounts (Google + GitHub sign-in), admin-managed app settings
-- and per-user daily message limits.
--
-- Only additive changes: the users table is NOT rebuilt, because dropping it would cascade
-- into sessions, conversations and memories. github_id therefore stays NOT NULL; accounts
-- created with Google get a unique negative placeholder there (see db/users.ts), and
-- github_login says whether a real GitHub account is linked.

-- GitHub username when a GitHub account is linked (NULL for Google-only accounts).
ALTER TABLE users ADD COLUMN github_login TEXT;
UPDATE users SET github_login = login;

-- Google account id ("sub"), when a Google account is linked.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);

-- Verified email from the sign-in provider (lower-case).
ALTER TABLE users ADD COLUMN email TEXT;
CREATE INDEX idx_users_email ON users(email);

-- 'active' or 'blocked' (blocked users can't sign in or use the API).
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked'));

-- Messages per day for this user; NULL means "use the app-wide default".
ALTER TABLE users ADD COLUMN daily_limit INTEGER;

-- App-wide settings managed by the admin (sign-ups open, default daily limit, bot instructions…).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Messages sent per user per UTC day, for the daily limit.
CREATE TABLE user_usage_daily (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
