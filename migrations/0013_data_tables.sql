-- Spreadsheets in chat: data analysis (v0.14.0).
--
-- Add-only and revert-safe: three new tables, three indexes and two new columns (one nullable, one with a default).
-- Nothing existing is changed or removed, so older code (v0.13.x) keeps working after a revert (it never reads these).
-- - data_files: one row per spreadsheet a user added (CSV or Excel). conversation_id is NULL until the message it is
--   attached to is sent. Deleting the chat deletes its files (and their rows); files never sent are removed by the
--   daily clean-up after 24 hours. Deleting the user deletes everything.
-- - data_tables: one row per sheet with data (a CSV file has one): the column overview the browser worked out, notes
--   about how it was read, and a few example rows.
-- - data_chunks: the rows themselves, in blocks of up to 500 (JSON: [[spreadsheet row number, cell, cell, …], …]),
--   so a 50,000-row file is about 100 database rows. Calculations run inside the database over these blocks.
-- - messages.files: the spreadsheets attached to a user message (JSON), for the chip on the message.
-- - user_usage_daily.tables: spreadsheets added per user per day (for the daily limit; admins counted, not limited).

CREATE TABLE IF NOT EXISTS data_files (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  bytes           INTEGER NOT NULL DEFAULT 0,       -- size of the original file
  stored_chars    INTEGER NOT NULL DEFAULT 0,       -- size of the stored rows
  status          TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_files_user ON data_files (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_data_files_conversation ON data_files (conversation_id);

CREATE TABLE IF NOT EXISTS data_tables (
  id              TEXT PRIMARY KEY,
  file_id         TEXT NOT NULL REFERENCES data_files(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,                 -- sheet order in the file
  sheet           TEXT,                             -- NULL for CSV
  row_count       INTEGER NOT NULL,
  first_row       INTEGER NOT NULL,                 -- spreadsheet row numbers of the first and last data row
  last_row        INTEGER NOT NULL,
  columns         TEXT NOT NULL,                    -- JSON: the column overview
  notes           TEXT NOT NULL DEFAULT '[]',       -- JSON: how the file was read
  samples         TEXT NOT NULL DEFAULT '[]',       -- JSON: a few example rows
  expected_chunks INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_tables_file ON data_tables (file_id, position);

CREATE TABLE IF NOT EXISTS data_chunks (
  table_id  TEXT NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  rows      TEXT NOT NULL,
  PRIMARY KEY (table_id, seq)
);

ALTER TABLE messages ADD COLUMN files TEXT;

ALTER TABLE user_usage_daily ADD COLUMN tables INTEGER NOT NULL DEFAULT 0;
