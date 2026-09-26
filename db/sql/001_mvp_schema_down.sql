-- =====================================================================
--  AI Life Concierge - UNDO for 001_mvp_schema_up.sql
--
--  WARNING: this DESTROYS data.
--  It drops the tasks, events and automation_logs tables and everything
--  in them, and drops the six new columns on users.
--
--  It does NOT touch any table or column that existed before the change.
--  Only run this to reverse a failed rollout.
-- =====================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_tasks_completed_at ON tasks;
DROP TRIGGER IF EXISTS trg_tasks_updated_at   ON tasks;

DROP TABLE IF EXISTS automation_logs;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS tasks;

DROP FUNCTION IF EXISTS set_task_completed_at();
-- set_updated_at() is left in place; it is generic and other tables may adopt it.

DROP INDEX IF EXISTS idx_users_onboarding_phase;
DROP INDEX IF EXISTS idx_users_conversation_mode;
DROP INDEX IF EXISTS idx_users_next_date_due_at;

-- Drop the new VARCHAR onboarding_phase, then put the legacy counter back
-- under its original name. Order matters: the name must be free first.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_phase_check;
ALTER TABLE users DROP COLUMN IF EXISTS onboarding_phase;

DO $$ BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'onboarding_step')
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'onboarding_phase')
  THEN
    ALTER TABLE users RENAME COLUMN onboarding_step TO onboarding_phase;
  END IF;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS onboarding_completed_at;
ALTER TABLE users DROP COLUMN IF EXISTS next_date_due_at;
ALTER TABLE users DROP COLUMN IF EXISTS date_night_cadence;
ALTER TABLE users DROP COLUMN IF EXISTS last_date_curated_at;
ALTER TABLE users DROP COLUMN IF EXISTS conversation_mode;

DROP TYPE IF EXISTS automation_status;
DROP TYPE IF EXISTS task_category;
DROP TYPE IF EXISTS task_priority;
DROP TYPE IF EXISTS task_status;
DROP TYPE IF EXISTS conversation_mode;

COMMIT;
