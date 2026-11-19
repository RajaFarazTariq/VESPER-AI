-- Answer verification (v0.11.0).
--
-- Add-only and revert-safe: three new columns, each with a default or allowing NULL, so older code (v0.10.1) that
-- doesn't know them keeps working after a revert. Nothing existing is changed or removed.
-- - messages.evidence: the source text an answer was based on (what the web search, pages, documents, weather or
--   currency tools returned; for deep research the collected material), at most ~20,000 characters, kept so the
--   answer can be checked later ("Check this answer"). Never sent to the browser. NULL = the answer used no sources
--   (or was saved by older code), so there is nothing to check it against.
-- - messages.verification: the result of the check as JSON (each key claim: supported / contradicted / not in the
--   sources, with the source). NULL = not checked.
-- - user_usage_daily.answer_checks: answer checks per user per day (for the daily limit; admins are counted, not limited).

ALTER TABLE messages ADD COLUMN evidence TEXT;

ALTER TABLE messages ADD COLUMN verification TEXT;

ALTER TABLE user_usage_daily ADD COLUMN answer_checks INTEGER NOT NULL DEFAULT 0;
