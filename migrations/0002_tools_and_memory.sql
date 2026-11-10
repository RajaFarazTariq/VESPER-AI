-- Phase 5: tool activity on messages, and long-term memory.

-- JSON array of tool calls made while producing an assistant reply (shown in the UI).
ALTER TABLE messages ADD COLUMN tools TEXT;

-- Facts the user asked the assistant to remember across conversations.
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('assistant', 'user')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_user_created ON memories(user_id, created_at);
