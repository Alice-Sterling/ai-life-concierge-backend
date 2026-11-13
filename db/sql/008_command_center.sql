-- =====================================================================
--  Command Center (Project 4).
--
--  users
--    account_status          the brief's five membership states. Derived from
--                            onboarding_phase by a trigger (below), so the
--                            legacy code that writes onboarding_phase with raw
--                            SQL cannot leave the two out of step.
--    cohort_id               e.g. 'cohort_1_alpha'. Not set by any code yet.
--    trial_duration_days     180 for Founding Members (the value the backend
--                            already uses everywhere).
--    human_override_until    when a hand-over to a human ends by itself.
--    calendar_disconnected_at / calendar_token_last_refreshed_at /
--    calendar_token_status   calendar-token health, for the context panel.
--
--  messages                  one row per WhatsApp message, either direction.
--                            The chat view reads this. `conversations` stays:
--                            it is what Alice reads as history.
--  proactive_send_locks      one row per (client, template, period). A second
--                            send of the same thing cannot insert its row.
--  admin_audit_logs          every /admin call: who, what, on whom.
--  user_memory_summaries     long-term memory for Alice (one row per client).
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 008_command_center_down.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(16) NOT NULL DEFAULT 'Waitlist';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cohort_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_duration_days INTEGER NOT NULL DEFAULT 180;
ALTER TABLE users ADD COLUMN IF NOT EXISTS human_override_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_disconnected_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_last_refreshed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_status VARCHAR(32);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_status_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('Active', 'Paused', 'Cancelled', 'Waitlist', 'Denied'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_trial_duration_days_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_trial_duration_days_check
      CHECK (trial_duration_days BETWEEN 1 AND 3650);
  END IF;
END $$;

-- onboarding_phase (the Airtable status, six values) -> account_status (five).
--   Active                         -> Active
--   Denied                         -> Denied
--   Waitlist, Approved, Onboarded  -> Waitlist   (not a member yet)
--   Inactive                       -> Paused or Cancelled if one of those was
--                                     set on purpose, otherwise Cancelled
CREATE OR REPLACE FUNCTION derive_account_status(phase TEXT, current_status TEXT) RETURNS TEXT AS $fn$
BEGIN
  IF phase = 'Active' THEN RETURN 'Active'; END IF;
  IF phase = 'Denied' THEN RETURN 'Denied'; END IF;
  IF phase = 'Inactive' THEN
    IF current_status IN ('Paused', 'Cancelled') THEN RETURN current_status; END IF;
    RETURN 'Cancelled';
  END IF;
  RETURN 'Waitlist';
END; $fn$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION sync_account_status() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.account_status := derive_account_status(NEW.onboarding_phase, NULL);
  ELSIF NEW.onboarding_phase IS DISTINCT FROM OLD.onboarding_phase THEN
    -- A pause or cancellation writes account_status and onboarding_phase
    -- ('Inactive') in one UPDATE; that explicit value is kept.
    NEW.account_status := derive_account_status(NEW.onboarding_phase, NEW.account_status);
  END IF;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_account_status ON users;
CREATE TRIGGER trg_users_account_status
  BEFORE INSERT OR UPDATE OF onboarding_phase ON users
  FOR EACH ROW EXECUTE FUNCTION sync_account_status();

-- Existing rows.
UPDATE users SET account_status = derive_account_status(onboarding_phase, NULL)
 WHERE account_status IS DISTINCT FROM derive_account_status(onboarding_phase, NULL)
   AND account_status NOT IN ('Paused', 'Cancelled');

-- Anyone already with a human keeps the two-hour clock they already had.
UPDATE users
   SET human_override_until = COALESCE(conversation_mode_changed_at, NOW()) + INTERVAL '2 hours'
 WHERE conversation_mode = 'human' AND human_override_until IS NULL;

-- Token health for clients who are already connected.
UPDATE users
   SET calendar_token_status = 'ok',
       calendar_token_last_refreshed_at = COALESCE(calendar_token_last_refreshed_at, calendar_token_updated_at)
 WHERE calendar_connected = true AND calendar_token_status IS NULL;

-- The auto-resume job's only query.
CREATE INDEX IF NOT EXISTS idx_users_human_override_until
  ON users (human_override_until) WHERE conversation_mode = 'human';

COMMENT ON COLUMN users.account_status IS
  'Active | Paused | Cancelled | Waitlist | Denied. Derived from onboarding_phase by trg_users_account_status.';
COMMENT ON COLUMN users.human_override_until IS
  'While conversation_mode = human: when Alice takes the client back by herself. Reset by every human action.';
COMMENT ON COLUMN users.calendar_token_status IS
  'ok | refresh_failed | disconnected. NULL = never connected.';

-- ---------------------------------------------------------------------
-- messages - the chat view's source
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction   VARCHAR(8)  NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type VARCHAR(16) NOT NULL CHECK (sender_type IN ('user', 'alice', 'human_agent', 'system')),
  content     TEXT NOT NULL,
  -- twilio_sid, template_key, actor, request_id, media, backfill marker...
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);

-- A Twilio retry of the same inbound message must not appear twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inbound_sid
  ON messages ((metadata->>'twilio_sid'))
  WHERE direction = 'inbound' AND metadata->>'twilio_sid' IS NOT NULL;

COMMENT ON TABLE messages IS
  'Every WhatsApp message in or out, one row each, plus system notes. Read by the Command Center.';

-- History from before this table existed, copied once (only while the table
-- is empty). Each exchange in `conversations` becomes the client line and
-- the reply; proactive templates that never had an inbound message come from
-- outbound_messages.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM messages) THEN
    INSERT INTO messages (user_id, direction, sender_type, content, metadata, created_at)
    SELECT c.user_id, 'inbound', 'user', c.message_body,
           jsonb_build_object('backfill', '008', 'conversation_id', c.id), c.timestamp
      FROM conversations c
     WHERE btrim(COALESCE(c.message_body, '')) <> '';

    INSERT INTO messages (user_id, direction, sender_type, content, metadata, created_at)
    SELECT c.user_id, 'outbound', 'alice', c.ai_response,
           jsonb_build_object('backfill', '008', 'conversation_id', c.id),
           c.timestamp + INTERVAL '1 millisecond'
      FROM conversations c
     WHERE btrim(COALESCE(c.ai_response, '')) <> '';

    INSERT INTO messages (user_id, direction, sender_type, content, metadata, created_at)
    SELECT o.user_id, 'outbound', 'alice', o.body,
           jsonb_build_object('backfill', '008', 'template_key', o.template_key, 'outbound_id', o.id),
           o.created_at
      FROM outbound_messages o
     WHERE o.template_key IS NOT NULL
       AND o.status IN ('sent', 'inline')
       -- Front-door templates answer an inbound message, so `conversations`
       -- already holds them (copied above). Only unprompted sends are missing.
       AND NOT EXISTS (
         SELECT 1 FROM conversations c
          WHERE c.user_id = o.user_id AND c.ai_response = o.body
            AND c.timestamp BETWEEN o.created_at - INTERVAL '2 minutes'
                                AND o.created_at + INTERVAL '2 minutes');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- proactive_send_locks - one proactive send per client, template and period
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_send_locks (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key VARCHAR(64)  NOT NULL,
  period_key   VARCHAR(128) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT proactive_send_locks_unique UNIQUE (user_id, template_key, period_key)
);

COMMENT ON TABLE proactive_send_locks IS
  'Idempotency for proactive sends: the unique key makes a retried or doubled job a no-op.';

-- ---------------------------------------------------------------------
-- admin_audit_logs - who did what through /admin
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id                    BIGSERIAL PRIMARY KEY,
  actor                 VARCHAR(128) NOT NULL,
  route                 VARCHAR(255) NOT NULL,
  user_id               UUID,
  action                VARCHAR(128) NOT NULL,
  request_body_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  status_code           INTEGER,
  ip                    VARCHAR(64),
  request_id            VARCHAR(64),
  timestamp             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_timestamp ON admin_audit_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_user ON admin_audit_logs (user_id, timestamp DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor ON admin_audit_logs (actor, timestamp DESC);

COMMENT ON TABLE admin_audit_logs IS
  'One row per /admin request. Bodies are stored with tokens and secrets removed.';

-- ---------------------------------------------------------------------
-- user_memory_summaries - Alice's long-term memory (as specified)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_memory_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  key_facts JSONB DEFAULT '{}'::jsonb, -- e.g., {"dietary_restrictions": ["gluten-free"], "favorite_airline": "BA"}
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_memory UNIQUE(user_id)
);

COMMIT;
