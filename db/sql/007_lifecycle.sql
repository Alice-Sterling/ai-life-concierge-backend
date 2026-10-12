-- =====================================================================
--  Lifecycle messages (Project 3: post-activation, reminders, nudges).
--
--  activated_at
--    When the client became Active (Stripe checkout, or the status set in
--    Airtable). The 48-hour post-activation ping counts from here.
--
--    Deliberately NOT backfilled: existing Active clients have no start
--    time, so the ping never fires for them out of the blue.
--
--  Everything else these features need already exists: sends are recorded
--  in outbound_messages with a template_key (005), which is how each job
--  knows whether it already sent a reminder.
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 007_lifecycle_down.sql
-- =====================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

COMMENT ON COLUMN users.activated_at IS
  'When the client became Active. Drives the 48-hour post-activation ping. Not backfilled.';

-- The reminder and ping jobs look up "was template X sent to this user".
CREATE INDEX IF NOT EXISTS idx_outbound_messages_template_key
  ON outbound_messages (template_key, user_id, created_at DESC)
  WHERE template_key IS NOT NULL;

COMMIT;
