-- Undo 008_command_center.sql. DESTRUCTIVE: drops the chat log, the send
-- locks, the admin audit trail and Alice's memory summaries.

BEGIN;

DROP TABLE IF EXISTS user_memory_summaries;
DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS proactive_send_locks;
DROP TABLE IF EXISTS messages;

DROP TRIGGER IF EXISTS trg_users_account_status ON users;
DROP FUNCTION IF EXISTS sync_account_status();
DROP FUNCTION IF EXISTS derive_account_status(TEXT, TEXT);

DROP INDEX IF EXISTS idx_users_human_override_until;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trial_duration_days_check;
ALTER TABLE users DROP COLUMN IF EXISTS account_status;
ALTER TABLE users DROP COLUMN IF EXISTS cohort_id;
ALTER TABLE users DROP COLUMN IF EXISTS trial_duration_days;
ALTER TABLE users DROP COLUMN IF EXISTS human_override_until;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_disconnected_at;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_token_last_refreshed_at;
ALTER TABLE users DROP COLUMN IF EXISTS calendar_token_status;

COMMIT;
