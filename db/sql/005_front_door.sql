-- =====================================================================
--  Front door (Project 3, Step A/B/E).
--
--  welcome_message_sent
--    The Active-member welcome goes out exactly once. Without a flag the
--    welcome would be re-sent every time the status is touched (Stripe,
--    Airtable, the inbound gate), and the client would get it three times.
--
--  conversation_mode_changed_at
--    When a user was last handed to (or back from) a human. The auto-resume
--    job hands a user back to Alice once a hand-off has been quiet for two
--    hours, and needs to know when the clock started.
--
--  outbound_messages.template_key
--    Which status template a row was. Lets the gate avoid re-sending the same
--    "you're on the waitlist" message to someone who writes five times in a
--    row, and answers "did they get the invitation?" from the table.
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 005_front_door_down.sql
-- =====================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_message_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_mode_changed_at TIMESTAMPTZ;

-- Anyone already in human mode starts the two-hour clock now, rather than
-- being handed back to Alice the moment the job first runs.
UPDATE users
   SET conversation_mode_changed_at = NOW()
 WHERE conversation_mode = 'human' AND conversation_mode_changed_at IS NULL;

-- The auto-resume job's only query.
CREATE INDEX IF NOT EXISTS idx_users_human_mode
  ON users (conversation_mode_changed_at)
  WHERE conversation_mode = 'human';

ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS template_key VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_template
  ON outbound_messages (user_id, template_key, created_at DESC)
  WHERE template_key IS NOT NULL;

COMMENT ON COLUMN users.welcome_message_sent IS
  'True once the Active-member welcome template has been sent. Never reset automatically.';
COMMENT ON COLUMN users.conversation_mode_changed_at IS
  'Last switch between ai and human. Drives the two-hour auto-resume.';
COMMENT ON COLUMN outbound_messages.template_key IS
  'Status template sent (e.g. status_waitlist). NULL for ordinary replies.';

COMMIT;
