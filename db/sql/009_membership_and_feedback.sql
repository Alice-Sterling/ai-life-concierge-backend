-- =====================================================================
--  Membership changes in WhatsApp and the voice-note feedback loop
--  (Project 4). Needs 008 (users.account_status).
--
--  users
--    stripe_customer_id, stripe_subscription_id
--        Which Stripe subscription belongs to the client. Stored at
--        checkout from now on; looked up by email once for older clients.
--    membership_paused_until
--        When a pause ends. The lifecycle job reactivates the client then.
--    paused_automations
--        The client's automations as they were before the pause. A pause
--        empties active_automations (no proactive messages); resuming puts
--        these back.
--    free_month_applied_at
--        The retention gift is given once per client.
--    feedback_requested_at
--        When the day-14 "send me a voice note" request went out. A voice
--        note in the following week is stored as feedback.
--
--  client_feedback
--        What clients told us, in their own words (the transcript of the
--        voice note, or typed text). One row per piece of feedback.
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 009_membership_and_feedback_down.sql
-- =====================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_paused_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_automations JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_month_applied_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_requested_at TIMESTAMPTZ;

-- The auto-resume job's only query.
CREATE INDEX IF NOT EXISTS idx_users_membership_paused_until
  ON users (membership_paused_until) WHERE membership_paused_until IS NOT NULL;

COMMENT ON COLUMN users.membership_paused_until IS
  'While account_status = Paused: when the pause ends and the client is reactivated.';
COMMENT ON COLUMN users.paused_automations IS
  'active_automations as they were before a pause; restored on resume.';

CREATE TABLE IF NOT EXISTS client_feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     VARCHAR(16) NOT NULL DEFAULT 'voice_note' CHECK (source IN ('voice_note', 'text')),
  content    TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_feedback_user ON client_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_feedback_created ON client_feedback (created_at DESC);

COMMENT ON TABLE client_feedback IS
  'Product feedback from clients, in their own words. Filled by the day-14 voice-note request.';

COMMIT;
