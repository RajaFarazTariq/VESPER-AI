-- Images + voice (v0.9.6).
--
-- Add-only migration: three new columns, nothing existing is changed or removed.
-- - messages.images: small previews (~20 KB JPEG data URLs, JSON array) of images attached to a user message.
--   The full-size images are sent to the model once and never stored.
-- - user_usage_daily.images / speech_seconds: per-user daily counters for the image and speech limits
--   (same table and same daily cleanup as the message counter).

ALTER TABLE messages ADD COLUMN images TEXT;

ALTER TABLE user_usage_daily ADD COLUMN images INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_usage_daily ADD COLUMN speech_seconds INTEGER NOT NULL DEFAULT 0;
