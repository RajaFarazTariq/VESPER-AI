-- Smarter memory (v0.10.0).
--
-- Add-only and revert-safe: four new columns, each with a default or allowing NULL, so older code (v0.9.10) that
-- doesn't know them keeps working after a revert. Nothing existing is changed or removed.
-- - memories.pinned: 1 = always given to the assistant ("always use"); 0 = only when related to the message.
-- - memories.updated_at: when the text was last edited in Settings (NULL = never edited).
-- - conversations.summary / summary_until: running notes of the older part of a long chat (written by the model,
--   at most ~1,600 characters) and the time of the newest message they cover. Older messages beyond the context
--   budget are summarised once instead of being silently dropped. NULL = no summary yet.

ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

ALTER TABLE memories ADD COLUMN updated_at INTEGER;

ALTER TABLE conversations ADD COLUMN summary TEXT;

ALTER TABLE conversations ADD COLUMN summary_until INTEGER;
