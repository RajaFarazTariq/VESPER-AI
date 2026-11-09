-- Initial schema. Applied with `wrangler d1 migrations apply DB --local|--remote`.
-- Timestamps are Unix epoch milliseconds (UTC).

-- People sign in with GitHub OAuth, so no passwords are stored.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL UNIQUE,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- The raw session token only ever lives in the user's cookie; we store its SHA-256 hash.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  model      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_conversations_user_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  reasoning       TEXT,
  provider        TEXT,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'partial', 'error')),
  error           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at);

-- Shared provider health: when a provider is rate-limited we skip it until cooldown_until.
CREATE TABLE provider_state (
  provider       TEXT PRIMARY KEY,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  updated_at     INTEGER NOT NULL
);

-- Per-day request counters so the UI can show how much free quota has been used.
CREATE TABLE usage_daily (
  day        TEXT NOT NULL,
  provider   TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

-- Fixed-window rate-limit counters (login attempts, chat requests).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Cached model catalogues fetched from each provider's /models endpoint.
CREATE TABLE model_cache (
  provider   TEXT PRIMARY KEY,
  models     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
