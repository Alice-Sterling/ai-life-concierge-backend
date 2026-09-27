-- =====================================================================
--  Travel-aware timezone, and encrypted calendar token storage.
--
--  Purely additive. Safe to run against a live database, in either order
--  relative to the deploy, and safe to run more than once.
--
--  Undo: 003_timezone_and_tokens_down.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- active_timezone
--
-- The agent's system prompt currently hard-codes Europe/London, so Alice
-- assumes London time for every client regardless of where they are. This
-- column is the per-user override she reads and updates.
--
-- An IANA name ('Europe/London', 'Asia/Dubai'), not a UTC offset: offsets
-- change twice a year and a stored offset silently goes wrong at the DST
-- boundary.
--
-- Validated against the server's own timezone database rather than a CHECK
-- list, so it stays correct as zones are added or renamed.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/London';

-- Validated by a trigger, not a CHECK: Postgres forbids subqueries in CHECK
-- constraints, and hard-coding the zone list would go stale. This consults the
-- server's own timezone database on every write.
CREATE OR REPLACE FUNCTION validate_active_timezone() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.active_timezone IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.active_timezone)
  THEN
    RAISE EXCEPTION 'Invalid IANA timezone: %. Expected a name such as Europe/London or Asia/Dubai.',
      NEW.active_timezone
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_validate_timezone ON users;
CREATE TRIGGER trg_users_validate_timezone
  BEFORE INSERT OR UPDATE OF active_timezone ON users
  FOR EACH ROW EXECUTE FUNCTION validate_active_timezone();

COMMENT ON COLUMN users.active_timezone IS
  'IANA timezone the client is currently in, e.g. Asia/Dubai. Updated by the agent when travel is mentioned.';

-- Set when the agent last changed it, so a stale travel timezone can be
-- spotted and reverted rather than following someone home from a trip.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_timezone_set_at TIMESTAMPTZ;


-- ---------------------------------------------------------------------
-- Calendar OAuth tokens, encrypted at rest.
--
-- Tokens are currently held in Airtable by an n8n workflow. Airtable is not
-- a secrets store: one API key opens the whole base, and fields are not
-- encrypted at rest, so every integration with base access can read every
-- client's calendar credentials.
--
-- These columns are the alternative. Values are AES-256-GCM ciphertext
-- produced by src/lib/crypto.js, keyed by TOKEN_ENCRYPTION_KEY, which lives
-- only in the environment. A database dump without that key yields nothing.
--
-- BYTEA rather than TEXT: ciphertext is binary, and base64 in a text column
-- invites something to "helpfully" trim or re-encode it.
--
-- Nothing writes these yet. They exist so the tokens can be migrated off
-- Airtable as a deliberate, separate step.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_access_token_enc  BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_refresh_token_enc BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_expires_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_scope       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_updated_at  TIMESTAMPTZ;

COMMENT ON COLUMN users.calendar_access_token_enc IS
  'AES-256-GCM ciphertext. Never log or return this. Decrypt via src/lib/crypto.js.';
COMMENT ON COLUMN users.calendar_refresh_token_enc IS
  'AES-256-GCM ciphertext. Never log or return this. Decrypt via src/lib/crypto.js.';

-- A refresh job needs to find tokens that are about to expire.
CREATE INDEX IF NOT EXISTS idx_users_calendar_token_expires_at
  ON users (calendar_token_expires_at)
  WHERE calendar_token_expires_at IS NOT NULL;

COMMIT;
