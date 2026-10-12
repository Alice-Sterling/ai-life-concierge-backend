-- =====================================================================
--  Undo 007_lifecycle.sql.
--
--  DESTRUCTIVE: drops activated_at. Roll the code back first: code that
--  reads the column breaks without it.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS idx_outbound_messages_template_key;
ALTER TABLE users DROP COLUMN IF EXISTS activated_at;

COMMIT;
