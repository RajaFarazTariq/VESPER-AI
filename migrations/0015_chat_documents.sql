-- Documents in chat (v0.16.0): users attach PDF, Word (.docx), text or Markdown files to a message and ask about them.
--
-- Add-only and revert-safe: three new tables, a full-text index with its triggers, two indexes and two new columns
-- (one nullable, one with a default). Nothing existing is changed or removed, so older code (v0.15.x) keeps working
-- after a revert (it never reads these).
-- - chat_documents: one row per file a user added. Only the text is stored (the browser reads the file; the original
--   file is never uploaded). conversation_id is NULL until the message it is attached to is sent. Deleting the chat
--   deletes its documents (and their passages); documents never sent are removed by the daily clean-up after 24 hours.
--   Deleting the user deletes everything.
-- - chat_document_chunks: the text in passages of about a third of a page, each with its place in the file
--   ("page 12", "section “Leave policy”"), so answers can cite it.
-- - chat_document_chunks_fts: full-text index over the passages (same set-up as the knowledge base, 0004). Searches
--   are always limited to the documents of one chat of one user.
-- - messages.documents: the documents attached to a user message (JSON), for the chip on the message.
-- - user_usage_daily.documents: documents added per user per day (for the daily limit; admins counted, not limited).

CREATE TABLE IF NOT EXISTS chat_documents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                      -- pdf | docx | txt | md
  bytes           INTEGER NOT NULL DEFAULT 0,         -- size of the original file
  pages           INTEGER,                            -- PDFs only
  status          TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  expected_chunks INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  char_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_documents_user ON chat_documents (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_documents_conversation ON chat_documents (conversation_id);

-- One row per passage. `id` is the rowid the full-text index points to.
CREATE TABLE IF NOT EXISTS chat_document_chunks (
  id          INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES chat_documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  UNIQUE (document_id, seq)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_document_chunks_fts USING fts5(
  text,
  content = 'chat_document_chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keep the index in step with the passages (deleting a chat or a document cascades to its passages).
CREATE TRIGGER IF NOT EXISTS chat_document_chunks_after_insert AFTER INSERT ON chat_document_chunks BEGIN
  INSERT INTO chat_document_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chat_document_chunks_after_delete AFTER DELETE ON chat_document_chunks BEGIN
  INSERT INTO chat_document_chunks_fts (chat_document_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chat_document_chunks_after_update AFTER UPDATE OF text ON chat_document_chunks BEGIN
  INSERT INTO chat_document_chunks_fts (chat_document_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chat_document_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

ALTER TABLE messages ADD COLUMN documents TEXT;

ALTER TABLE user_usage_daily ADD COLUMN documents INTEGER NOT NULL DEFAULT 0;
