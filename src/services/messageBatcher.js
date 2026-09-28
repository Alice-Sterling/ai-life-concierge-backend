/**
 * Message batching.
 *
 * People write to WhatsApp in bursts. Answering each fragment separately gives
 * the client three replies to one thought, the first two written without the
 * context of the rest, at three times the cost.
 *
 * Inbound messages are queued. A sweeper waits until the client has stopped
 * typing for QUIET_MS, then hands the whole burst to the agent as one turn and
 * sends a single reply through the Twilio API.
 *
 * The queue is in Postgres, not memory, so a deploy mid-burst does not drop
 * anyone's message, and two instances cannot answer the same burst twice.
 *
 * Batching requires the Twilio API, because by the time the burst is complete
 * the webhook has long since responded. Where Twilio is not configured the
 * webhook falls back to answering inline, exactly as before.
 */

const db = require('../db/pool');
const twilio = require('../integrations/twilio');
const events = require('./events');
const { logger } = require('../lib/logger');

/** How long a client must be quiet before the burst is considered finished. */
const QUIET_MS = Number.parseInt(process.env.BATCH_QUIET_MS || '7000', 10);

/** How often the sweeper looks for finished bursts. */
const SWEEP_MS = Number.parseInt(process.env.BATCH_SWEEP_MS || '2000', 10);

/** A batch that keeps failing is parked rather than retried forever. */
const MAX_ATTEMPTS = 3;

/** Batching is only possible if we can send a message outside the webhook. */
function isEnabled() {
  return twilio.isConfigured();
}

/**
 * Queue an inbound message.
 * @returns {Promise<boolean>} false if this was a duplicate Twilio retry
 */
async function enqueue({ userId, messageSid, body, fromNumber, requestId }, log = logger) {
  const { rows } = await db.query(
    `INSERT INTO pending_messages (user_id, message_sid, body, from_number, request_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_sid) DO NOTHING
     RETURNING id`,
    [userId, messageSid || null, body, fromNumber, requestId],
    log
  );

  // No row back means the sid was already queued: Twilio retried, and the
  // original is either waiting or already answered.
  if (!rows[0]) {
    log.info('batch.duplicate_ignored', { user_id: userId, message_sid: messageSid });
    return false;
  }

  log.info('batch.queued', { user_id: userId, message_sid: messageSid });
  return true;
}

/**
 * Claim one user whose burst has gone quiet.
 *
 * The claim is a single UPDATE ... WHERE state = 'pending', so two instances
 * racing cannot both take the same burst: the second updates zero rows.
 *
 * @returns {Promise<{userId: string, messages: object[]}|null>}
 */
async function claimNextBatch(log = logger) {
  const { rows: due } = await db.query(
    `SELECT user_id
       FROM pending_messages
      WHERE state = 'pending' AND attempts < $2
      GROUP BY user_id
     HAVING MAX(received_at) < NOW() - ($1 || ' milliseconds')::interval
      ORDER BY MIN(received_at)
      LIMIT 1`,
    [QUIET_MS, MAX_ATTEMPTS],
    log
  );
  if (!due[0]) return null;

  const userId = due[0].user_id;
  const { rows: claimed } = await db.query(
    `UPDATE pending_messages
        SET state = 'processing', attempts = attempts + 1
      WHERE user_id = $1 AND state = 'pending'
      RETURNING id, body, message_sid, from_number, request_id, received_at`,
    [userId],
    log
  );
  if (claimed.length === 0) return null; // another instance got there first

  return { userId, messages: claimed };
}

/**
 * Join a burst into the single message the agent sees.
 *
 * Newlines rather than spaces: "I'm in Dubai" and "this week" are separate
 * thoughts, and running them together reads as one garbled sentence.
 */
function combine(messages) {
  return messages.map((m) => String(m.body).trim()).filter(Boolean).join('\n');
}

async function markDone(ids, state, error = null, log = logger) {
  await db.query(
    `UPDATE pending_messages SET state = $2, processed_at = NOW(), last_error = $3 WHERE id = ANY($1::bigint[])`,
    [ids, state, error],
    log
  );
}

/**
 * Send a reply and record what Twilio said about it.
 *
 * Recorded before the send as 'queued' and updated afterwards, so a crash
 * mid-send still leaves a trace rather than a silent gap.
 */
async function sendReply(userId, to, body, requestId, log = logger) {
  const { rows } = await db.query(
    `INSERT INTO outbound_messages (user_id, body, request_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, body, requestId],
    log
  );
  const outboundId = rows[0].id;

  const ok = await twilio.sendWhatsApp(to, body, log);

  await db.query(
    'UPDATE outbound_messages SET status = $2 WHERE id = $1',
    [outboundId, ok ? 'sent' : 'failed'],
    log
  );
  return ok;
}

/**
 * Process one due batch.
 *
 * @param {(user, text, ctx) => Promise<string>} runFlow the shared conversation flow
 * @returns {Promise<boolean>} whether a batch was processed
 */
async function processNextBatch(runFlow, log = logger) {
  const batch = await claimNextBatch(log);
  if (!batch) return false;

  const { userId, messages } = batch;
  const ids = messages.map((m) => m.id);
  const requestId = messages[messages.length - 1].request_id;
  const batchLog = log.child({ user_id: userId, request_id: requestId });
  const combined = combine(messages);

  batchLog.info('batch.processing', {
    message_count: messages.length,
    span_ms: new Date(messages[messages.length - 1].received_at) - new Date(messages[0].received_at),
  });

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId], batchLog);
    const user = rows[0];
    if (!user) {
      await markDone(ids, 'failed', 'user no longer exists', batchLog);
      return true;
    }

    // The same flow the inline path runs: enrichment, handshakes, the trial
    // branch, then the agent. It writes the conversation row itself, so the
    // burst appears in history exactly as the client sent it, and so the two
    // paths cannot record things differently.
    const to = messages[0].from_number || user.phone_number;
    const reply = await runFlow(user, combined, {
      phoneNumber: to,
      requestId,
      log: batchLog,
    });
    const body = typeof reply === 'string' && reply.trim() !== ''
      ? reply
      : 'I have received your message. One moment while I prepare a reply.';
    const sent = await sendReply(userId, to, body, requestId, batchLog);

    await markDone(ids, 'done', sent ? null : 'reply generated but Twilio send failed', batchLog);

    if (messages.length > 1) {
      await events.record('messages_batched', {
        userId, requestId, metadata: { message_count: messages.length },
      }, batchLog);
    }

    batchLog.info('batch.done', { message_count: messages.length, sent });
  } catch (err) {
    batchLog.error('batch.failed', { message: err.message, attempts: messages[0].attempts });

    // Back to 'pending' so the sweeper retries, until MAX_ATTEMPTS parks it.
    // Parked batches are visible in the table rather than lost.
    await db.query(
      `UPDATE pending_messages
          SET state = CASE WHEN attempts >= $2 THEN 'failed'::pending_message_state
                           ELSE 'pending'::pending_message_state END,
              last_error = $3
        WHERE id = ANY($1::bigint[])`,
      [ids, MAX_ATTEMPTS, err.message],
      batchLog
    );
  }
  return true;
}

let timer = null;

/** Start the sweeper. Called once from server.js. */
function start(runFlow, log = logger) {
  if (!isEnabled()) {
    log.warn('batch.disabled', {
      reason: 'Twilio is not configured; the webhook will answer inline instead.',
    });
    return null;
  }
  if (timer) return timer;

  log.info('batch.sweeper_started', { quiet_ms: QUIET_MS, sweep_ms: SWEEP_MS });

  let running = false;
  timer = setInterval(async () => {
    // A slow agent turn must not stack sweeps on top of each other.
    if (running) return;
    running = true;
    try {
      // Drain rather than take one per tick, so a queue that built up during
      // a deploy clears immediately instead of over several minutes.
      while (await processNextBatch(runFlow, log)) { /* keep going */ }
    } catch (err) {
      log.error('batch.sweep_failed', { message: err.message });
    } finally {
      running = false;
    }
  }, SWEEP_MS);

  timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  QUIET_MS,
  isEnabled,
  enqueue,
  combine,
  claimNextBatch,
  processNextBatch,
  start,
  stop,
};
