-- Answer feedback (v0.9.7): 👍/👎 under each answer, with an optional reason and note.
--
-- Add-only migration: one new table and two indexes. Nothing existing is changed.
-- Each row keeps a copy of the question, the answer, the model and the sources, so a 👎 is not lost when the user
-- then presses Regenerate (which deletes the old answer). Rows go when their chat or their user is deleted.

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id      TEXT PRIMARY KEY,                                              -- the rated answer (may since be regenerated away)
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating          INTEGER NOT NULL CHECK (rating IN (-1, 1)),                    -- 1 = 👍, -1 = 👎
  reason          TEXT,                                                          -- wrong / outdated / unanswered / other (👎 only)
  note            TEXT,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  provider        TEXT,
  model           TEXT,
  sources         TEXT,                                                          -- JSON array of the answer's sources
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_updated ON message_feedback (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_feedback_conversation ON message_feedback (conversation_id);
