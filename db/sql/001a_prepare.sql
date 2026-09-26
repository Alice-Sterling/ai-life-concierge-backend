-- =====================================================================
--  STEP 1 of 2 - PREPARE.  Run this BEFORE deploying the new code.
--
--  Safe to run while the CURRENT code is live and serving traffic.
--  Everything here is additive. Nothing existing is renamed, retyped or
--  dropped, so the running app does not notice.
--
--  After this, both the old and the new code work:
--    - old code keeps reading and writing onboarding_phase (INTEGER)
--    - new code reads onboarding_step, which is a copy of it
--
--  Then deploy the code, then run 001b_finalize.sql.
--  Safe to run more than once.
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
-- onboarding_step: a COPY of the existing counter, under its new name.
--
-- The old code carries on using onboarding_phase; the new code will use
-- this. For the short gap between this script and the deploy, the two can
-- drift by at most a few onboarding steps. 001b re-syncs them before the
-- old column goes away, so nothing is lost.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 1;

-- Guarded: on a brand-new database created by the current init-db.sql there is
-- no integer onboarding_phase to copy from, and an unguarded UPDATE would fail
-- the whole script on a fresh deploy.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
       AND column_name = 'onboarding_phase' AND data_type = 'integer')
  THEN
    UPDATE users
       SET onboarding_step = COALESCE(onboarding_phase, 1)
     WHERE onboarding_step IS DISTINCT FROM COALESCE(onboarding_phase, 1);
  END IF;
END $$;

COMMENT ON COLUMN users.onboarding_step IS
  'The 1..8 conversational onboarding counter, formerly named onboarding_phase.';


-- ---------------------------------------------------------------------
-- The remaining new user columns. Purely additive.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_mode       conversation_mode NOT NULL DEFAULT 'ai';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_date_curated_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_night_cadence      INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_date_due_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN users.conversation_mode  IS 'When human, inbound messages are queued for review instead of answered by the agent.';
COMMENT ON COLUMN users.date_night_cadence IS 'Interval between date nights, in days. 7 = weekly.';
COMMENT ON COLUMN users.next_date_due_at   IS 'Derived: last_date_curated_at + date_night_cadence days. Read by the date-night cron.';

CREATE INDEX IF NOT EXISTS idx_users_next_date_due_at
  ON users (next_date_due_at) WHERE next_date_due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_conversation_mode
  ON users (conversation_mode) WHERE conversation_mode = 'human';


-- ---------------------------------------------------------------------
-- tasks - human-in-the-loop queue
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

CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at  ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id_created_at ON tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_airtable_record_id ON tasks (airtable_record_id);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
-- events - product funnel tracking
--
-- user_id is nullable and deliberately NOT a foreign key: anonymous events
-- such as portal_viewed happen before a user row exists.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id   BIGSERIAL PRIMARY KEY,
  user_id    UUID,
  event_name VARCHAR(128) NOT NULL,
  metadata   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  request_id VARCHAR(64),
  timestamp  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_name_timestamp    ON events (event_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_id_timestamp ON events (user_id, timestamp DESC) WHERE user_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- automation_logs - audit trail
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

CREATE INDEX IF NOT EXISTS idx_automation_logs_type_timestamp
  ON automation_logs (automation_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_automation_logs_failed
  ON automation_logs (timestamp DESC) WHERE status = 'failed';

COMMIT;
