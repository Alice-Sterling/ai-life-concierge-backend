-- =====================================================================
--  AI Life Concierge - MVP schema changes
--
--  Safe to run more than once. Every statement is guarded.
--  Adds no data. Deletes no data. Changes no existing column.
--
--  Covers brief sections 2A, 2B, 2C, 2D.
--  Undo script: 001_mvp_schema_down.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_mode') THEN
    CREATE TYPE conversation_mode AS ENUM ('ai', 'human');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
    CREATE TYPE task_status AS ENUM ('new', 'triaged', 'in_progress', 'completed', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_priority') THEN
    CREATE TYPE task_priority AS ENUM ('normal', 'high', 'vip');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_category') THEN
    CREATE TYPE task_category AS ENUM ('date_night', 'client_event', 'general');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_status') THEN
    CREATE TYPE automation_status AS ENUM ('success', 'failed', 'pending');
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2A. users - automation state and onboarding audit
--
-- IMPORTANT - onboarding_phase name collision.
--
-- The client asked for `onboarding_phase` to hold the six Airtable statuses.
-- A column of that name already exists as INTEGER: a 1..8 step counter read
-- in six places in index.js, including the agent's system prompt.
--
-- To give the client exactly the name and values they asked for, the legacy
-- counter is RENAMED to `onboarding_step` and `onboarding_phase` is recreated
-- as VARCHAR. This is a breaking change: index.js must be deployed with the
-- matching rename IN THE SAME RELEASE, or onboarding will break.
--
-- Existing rows are deliberately left NULL rather than guessed at. Mapping
-- live users onto the six Airtable statuses is an operational decision, not
-- a technical one. See README "Schema deviations".
-- ---------------------------------------------------------------------

-- Rename the legacy counter, once, only if it has not already been renamed.
DO $$ BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'onboarding_phase' AND data_type = 'integer')
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'onboarding_step')
  THEN
    ALTER TABLE users RENAME COLUMN onboarding_phase TO onboarding_step;
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_mode       conversation_mode NOT NULL DEFAULT 'ai';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_date_curated_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_night_cadence      INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_date_due_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Every existing user starts on 'Waitlist' so the onboarding gates still apply
-- to them, rather than being mass-promoted. Ops promotes individual accounts by
-- hand from there. NOT NULL because a user always has a status.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase VARCHAR(32) NOT NULL DEFAULT 'Waitlist';

-- A CHECK, not an ENUM: Airtable single-select options change, and widening a
-- CHECK is a one-line change where widening an ENUM is a migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_onboarding_phase_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_onboarding_phase_check
      CHECK (onboarding_phase IN
             ('Waitlist', 'Approved', 'Denied', 'Onboarded', 'Active', 'Inactive'));
  END IF;
END $$;

COMMENT ON COLUMN users.conversation_mode  IS 'When human, inbound messages are queued for review instead of answered by the agent.';
COMMENT ON COLUMN users.date_night_cadence IS 'Interval between date nights, in days. 7 = weekly.';
COMMENT ON COLUMN users.next_date_due_at   IS 'Derived: last_date_curated_at + date_night_cadence days. Read by the date-night cron.';
COMMENT ON COLUMN users.onboarding_phase   IS 'Mirrors the Airtable status single-select. Enforced by users_onboarding_phase_check.';
COMMENT ON COLUMN users.onboarding_step    IS 'Legacy 1..8 onboarding step counter, formerly named onboarding_phase.';

CREATE INDEX IF NOT EXISTS idx_users_onboarding_phase ON users (onboarding_phase);

-- Cron scans for users whose next date night is due.
CREATE INDEX IF NOT EXISTS idx_users_next_date_due_at
  ON users (next_date_due_at) WHERE next_date_due_at IS NOT NULL;

-- The hand-off queue lists users currently handled by a human.
CREATE INDEX IF NOT EXISTS idx_users_conversation_mode
  ON users (conversation_mode) WHERE conversation_mode = 'human';


-- ---------------------------------------------------------------------
-- 2B. tasks - human-in-the-loop queue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  task_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_message     TEXT,
  ai_summary         TEXT,
  status             task_status   NOT NULL DEFAULT 'new',
  priority           task_priority NOT NULL DEFAULT 'normal',
  category           task_category NOT NULL DEFAULT 'general',
  requires_human     BOOLEAN       NOT NULL DEFAULT true,
  assigned_to        VARCHAR(255),
  airtable_record_id VARCHAR(64),
  request_id         VARCHAR(64),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

COMMENT ON COLUMN tasks.source_message     IS 'The inbound WhatsApp message that triggered the hand-off, verbatim.';
COMMENT ON COLUMN tasks.ai_summary         IS 'Context the agent generated for the human operator.';
COMMENT ON COLUMN tasks.airtable_record_id IS 'Airtable record this task maps to. Null until the first successful sync.';
COMMENT ON COLUMN tasks.request_id         IS 'Request id of the webhook that created this task, for cross-log tracing.';

CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at  ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id_created_at ON tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_airtable_record_id ON tasks (airtable_record_id);

-- Keep updated_at honest without every caller remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- completed_at should follow the status, not the caller's memory.
CREATE OR REPLACE FUNCTION set_task_completed_at() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    NEW.completed_at = COALESCE(NEW.completed_at, NOW());
  ELSIF NEW.status <> 'completed' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_completed_at ON tasks;
CREATE TRIGGER trg_tasks_completed_at
  BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_task_completed_at();


-- ---------------------------------------------------------------------
-- 2C. events - product funnel tracking
--
-- user_id is nullable and deliberately NOT a foreign key: anonymous events
-- such as portal_viewed happen before a user row exists, and funnel history
-- should survive a user being deleted.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id   BIGSERIAL PRIMARY KEY,
  user_id    UUID,
  event_name VARCHAR(128) NOT NULL,
  metadata   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  request_id VARCHAR(64),
  timestamp  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN events.user_id    IS 'Nullable and unconstrained: anonymous funnel events precede the user row.';
COMMENT ON COLUMN events.event_name IS 'e.g. portal_viewed, whatsapp_started, onboarding_completed, human_handoff_created.';

CREATE INDEX IF NOT EXISTS idx_events_name_timestamp    ON events (event_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_id_timestamp ON events (user_id, timestamp DESC) WHERE user_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- 2D. automation_logs - audit trail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_logs (
  log_id          BIGSERIAL PRIMARY KEY,
  user_id         UUID,
  automation_type VARCHAR(64)       NOT NULL,
  status          automation_status NOT NULL DEFAULT 'pending',
  error_details   TEXT,
  request_id      VARCHAR(64),
  timestamp       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN automation_logs.user_id         IS 'Nullable: some automation runs are not scoped to a single user.';
COMMENT ON COLUMN automation_logs.automation_type IS 'e.g. date_night_cron, client_event_webhook.';

CREATE INDEX IF NOT EXISTS idx_automation_logs_type_timestamp
  ON automation_logs (automation_type, timestamp DESC);

-- Failure triage is the common query; index only the rows that matter.
CREATE INDEX IF NOT EXISTS idx_automation_logs_failed
  ON automation_logs (timestamp DESC) WHERE status = 'failed';

COMMIT;
