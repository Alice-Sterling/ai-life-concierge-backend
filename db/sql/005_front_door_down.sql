-- Undo 005_front_door.sql. DESTRUCTIVE: drops the welcome flag and the
-- hand-off timestamps. Roll the code back first, or the webhook will query
-- columns that no longer exist.

BEGIN;

DROP INDEX IF EXISTS idx_outbound_messages_template;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS template_key;

DROP INDEX IF EXISTS idx_users_human_mode;
ALTER TABLE users DROP COLUMN IF EXISTS conversation_mode_changed_at;
ALTER TABLE users DROP COLUMN IF EXISTS welcome_message_sent;

COMMIT;
