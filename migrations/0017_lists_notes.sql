-- More tasks (v0.19.0): lists and notes VESPER keeps for the user, archived chats, and changing or cancelling
-- calendar events.
--
-- Add-only and revert-safe: three new tables, their indexes and two new nullable columns. Nothing existing is changed
-- or removed, so older code (v0.18.x) keeps working after a revert (it never reads these).
-- - lists: the user's named lists ("To-do" is the default; "Shopping", "Packing"… are made on demand). name_key is the
--   name in lower case, so "shopping" and "Shopping" are the same list (one per name and user). At most 20 per user.
-- - list_items: the items, in the order they were added, each with a done flag. At most 200 per list, 200 characters
--   each. Deleted with their list.
-- - notes: short free-text notes ("note that the gate code is on the green card"). At most 500 per user, 2,000
--   characters each. Like memories, passwords and card/bank/ID/phone numbers are refused before they are saved.
-- - conversations.archived_at: when the user archived the chat (NULL = not archived). Archived chats are kept but left
--   out of the chat list; a new message in one un-archives it. Older code ignores the column and lists every chat.
-- - google_actions.op: what a calendar card does ('update' = change an event, 'delete' = cancel it; NULL = a new event
--   or an email). The full change is in the payload until the user decides; this column keeps "Change event" /
--   "Cancel event" in the log afterwards, when the payload is no longer kept. (kind stays 'event': its CHECK can't
--   change without rebuilding the table.)
-- Deleting the user deletes their lists, items and notes.

CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,                     -- lower-case name, e.g. 'to-do', 'shopping'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name_key)
);

CREATE INDEX IF NOT EXISTS idx_lists_user_updated ON lists (user_id, updated_at);

CREATE TABLE IF NOT EXISTS list_items (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items (list_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes (user_id, created_at);

ALTER TABLE conversations ADD COLUMN archived_at INTEGER;

-- The chat list (not archived, newest first) and the archive (newest archived first).
CREATE INDEX IF NOT EXISTS idx_conversations_user_archived ON conversations (user_id, archived_at, updated_at);

ALTER TABLE google_actions ADD COLUMN op TEXT;
