-- =====================================================================
--  Calendar connection state.
--
--  003 added encrypted token columns but nothing wrote them: the n8n
--  onboarding workflow kept the tokens in Airtable, in clear text. The
--  backend now receives them straight after the OAuth exchange
--  (POST /admin/calendar/connect), encrypts them, and records here that
--  the calendar is connected, so Alice never asks the client to reconnect.
--
--  Purely additive. Safe on a live database, either side of a deploy, and
--  safe to run more than once.
--  Undo: 006_calendar_connection_down.sql
-- =====================================================================

BEGIN;

-- The brief's calendar_connected flag. A real column rather than inferring it
-- from calendar_provider: a provider can be chosen on the form long before
-- the client finishes the OAuth handshake.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_connected    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_connected_at TIMESTAMPTZ;

-- The timezone the calendar itself reports, kept apart from active_timezone.
-- active_timezone follows the client when they travel; this is the home base
-- to return to afterwards. IANA name, validated in the app.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_timezone VARCHAR(64);

COMMENT ON COLUMN users.calendar_connected IS
  'True once calendar tokens are stored in calendar_*_token_enc. Set by POST /admin/calendar/connect.';
COMMENT ON COLUMN users.calendar_timezone IS
  'IANA timezone reported by the connected calendar at OAuth time. Home base; active_timezone may differ while travelling.';

COMMIT;
