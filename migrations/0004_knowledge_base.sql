-- Knowledge base (v0.9.0): collections of documents the administrator adds (PDF, Word, text, Markdown,
-- CSV, web pages). Every signed-in user's assistant can search them and cite "document, page X".
--
-- Add-only migration: new tables, a full-text index and its triggers. Nothing existing is changed.
--
-- Only extracted text is stored (split into passages of about a third of a page), never the original
-- files. Passages are found with SQLite FTS5 full-text search (BM25 ranking); at question time the
-- best candidates are re-ordered by meaning with Workers AI's re-ranker.

CREATE TABLE IF NOT EXISTS kb_collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_documents (
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL REFERENCES kb_collections(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,                      -- pdf | docx | txt | md | csv | web
  source_url      TEXT,                               -- web pages only
  status          TEXT NOT NULL DEFAULT 'uploading',  -- uploading | ready
  pages           INTEGER,                            -- PDFs only
  expected_chunks INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  char_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_collection ON kb_documents(collection_id, created_at);

-- One row per passage. `id` is the rowid the full-text index points to.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  location    TEXT NOT NULL DEFAULT '',  -- e.g. "page 12", "section “Leave policy”", "rows 2–41"
  text        TEXT NOT NULL,
  UNIQUE (document_id, seq)
);

-- Full-text index over kb_chunks.text (external content: the text is stored once, in kb_chunks).
-- porter = English word stems (policy/policies); unicode61 + remove_diacritics for other scripts.
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  text,
  content = 'kb_chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keep the index in step with kb_chunks (deleting a document or collection cascades to its passages).
CREATE TRIGGER IF NOT EXISTS kb_chunks_after_insert AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_after_delete AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_after_update AFTER UPDATE OF text ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO kb_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
