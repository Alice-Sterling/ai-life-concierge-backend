-- =====================================================================
--  Undo 006_calendar_connection.sql.
--
--  DESTRUCTIVE: drops the connection flag and the calendar timezone. The
--  encrypted tokens themselves live in 003's columns and are untouched.
--  Roll the code back first: code that reads these columns breaks without them.
-- =====================================================================

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS calendar_timezone;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_connected_at;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_connected;

COMMIT;
