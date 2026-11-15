-- Undo 009_membership_and_feedback.sql. DESTRUCTIVE: drops stored client
-- feedback and the link between clients and their Stripe subscriptions.

BEGIN;

DROP TABLE IF EXISTS client_feedback;

DROP INDEX IF EXISTS idx_users_membership_paused_until;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE users DROP COLUMN IF EXISTS membership_paused_until;
ALTER TABLE users DROP COLUMN IF EXISTS paused_automations;
ALTER TABLE users DROP COLUMN IF EXISTS free_month_applied_at;
ALTER TABLE users DROP COLUMN IF EXISTS feedback_requested_at;

COMMIT;
