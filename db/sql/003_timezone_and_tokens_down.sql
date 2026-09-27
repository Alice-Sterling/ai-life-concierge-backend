-- =====================================================================
--  UNDO for 003_timezone_and_tokens.sql
--
--  WARNING: this DESTROYS data. Dropping the token columns discards any
--  stored calendar credentials, which cannot be recovered - the clients
--  would have to reconnect their calendars.
--
--  Only run this to reverse a failed rollout.
-- =====================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_users_validate_timezone ON users;
DROP FUNCTION IF EXISTS validate_active_timezone();

DROP INDEX IF EXISTS idx_users_calendar_token_expires_at;

ALTER TABLE users DROP COLUMN IF EXISTS calendar_token_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_token_scope;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_token_expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_refresh_token_enc;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_access_token_enc;

ALTER TABLE users DROP COLUMN IF EXISTS active_timezone_set_at;
ALTER TABLE users DROP COLUMN IF EXISTS active_timezone;

COMMIT;
