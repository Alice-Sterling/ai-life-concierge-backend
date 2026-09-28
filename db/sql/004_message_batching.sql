-- =====================================================================
--  Message batching.
--
--  People write to WhatsApp in bursts: "I'm in Dubai" / "this week" /
--  "find me dinner Thursday". Today each of those runs the agent
--  separately, so the client gets three replies, the first two written
--  without the context of the rest, at three times the cost.
--
--  Inbound messages land here first. A sweeper picks up each user's burst
--  once they have stopped typing and hands the whole thing to the agent as
--  one turn.
--
--  The queue lives in Postgres rather than in memory so a deploy or a crash
--  mid-burst does not silently drop somebody's message.
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 004_message_batching_down.sql
-- =====================================================================

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pending_message_state') THEN
    CREATE TYPE pending_message_state AS ENUM ('pending', 'processing', 'done', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pending_messages (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Twilio's own id for the message. UNIQUE so a Twilio retry cannot enqueue
  -- the same text twice: on a duplicate the insert is simply ignored.
  message_sid   VARCHAR(64) UNIQUE,

  body          TEXT NOT NULL,
  from_number   VARCHAR(50),
  request_id    VARCHAR(64),

  state         pending_message_state NOT NULL DEFAULT 'pending',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,

  -- Set when a batch fails, so the sweeper can back off instead of retrying
  -- a poisonous message forever.
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

-- The sweeper's only query: whose burst has gone quiet?
CREATE INDEX IF NOT EXISTS idx_pending_messages_pending
  ON pending_messages (user_id, received_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_messages_state_received
  ON pending_messages (state, received_at);

COMMENT ON TABLE pending_messages IS
  'Inbound WhatsApp messages awaiting batching. Rows are kept after processing as a delivery audit trail.';
COMMENT ON COLUMN pending_messages.message_sid IS
  'Twilio MessageSid. UNIQUE, so a Twilio retry is ignored rather than answered twice.';

-- ---------------------------------------------------------------------
-- Outbound delivery record.
--
-- Once replies go out through the Twilio API rather than in the webhook
-- response, "did the client actually receive it?" stops being answerable
-- from the conversation table alone.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_messages (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  twilio_sid    VARCHAR(64),
  status        VARCHAR(32) NOT NULL DEFAULT 'queued',
  error_code    VARCHAR(32),
  error_message TEXT,
  request_id    VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_user_created
  ON outbound_messages (user_id, created_at DESC);

-- Failure triage: index only the rows worth looking at.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_failed
  ON outbound_messages (created_at DESC)
  WHERE status IN ('failed', 'undelivered');

COMMENT ON TABLE outbound_messages IS
  'Replies sent via the Twilio API, with delivery status. Answers "did it actually arrive?".';

COMMIT;
