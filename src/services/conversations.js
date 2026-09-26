/**
 * Conversation history.
 *
 * One row per exchange: the inbound message and the reply that went back.
 * The request id is stored in metadata so a conversation row can be traced to
 * the webhook that produced it, and from there to every integration call.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

/** Persist one exchange. `aiResponse` is null when the message was queued for a human. */
async function save(userId, messageBody, aiResponse, metadata = {}, log = logger) {
  const { rows } = await db.query(
    `INSERT INTO conversations (user_id, message_body, ai_response, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, timestamp`,
    [
      userId,
      messageBody,
      aiResponse,
      JSON.stringify({ ...metadata, request_id: log.bindings?.().request_id ?? null }),
    ],
    log
  );
  return rows[0];
}

/**
 * Recent history for a user, oldest first.
 *
 * Oldest-first because the agent reads this as a transcript. The LIMIT has to
 * apply to the newest rows, so the ordering is reversed in a subquery and
 * flipped back outside it.
 */
async function getHistory(userId, { limit = 20 } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const { rows } = await db.query(
    `SELECT id, message_body, ai_response, metadata, timestamp
       FROM (
         SELECT id, message_body, ai_response, metadata, timestamp
           FROM conversations WHERE user_id = $1
          ORDER BY timestamp DESC LIMIT $2
       ) recent
      ORDER BY timestamp ASC`,
    [userId, capped],
    log
  );
  return rows;
}

module.exports = { save, getHistory };
