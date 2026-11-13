/**
 * The message log behind the Command Center (Project 4).
 *
 * One row per WhatsApp message, either direction, plus short system notes
 * ("Human mode engaged"). The chat view reads this table. `conversations`
 * stays as it is: that is the exchange history Alice reads.
 *
 * Every write here is best-effort. Losing a line of the chat log is
 * acceptable; failing a client's message because the log threw is not. That
 * also makes the code safe to deploy before migration 008 has been applied.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const DIRECTIONS = ['inbound', 'outbound'];
const SENDER_TYPES = ['user', 'alice', 'human_agent', 'system'];

/** Prefix on a transcribed voice note, as the brief specifies. */
const AUDIO_PREFIX = '[AUDIO TRANSCRIPT]';

/** Shown when a media message arrives with no text and no transcript. */
const MEDIA_PLACEHOLDER = '[Media message, no text]';
const VOICE_PLACEHOLDER = '[Voice note, not transcribed]';

const digits = (phone) => String(phone || '').replace(/\D/g, '');

/**
 * Write one message.
 * @returns {Promise<object|null>} the row; null when it was not written
 *   (empty content, a duplicate inbound message, or the table is missing)
 */
async function record({ userId, direction, senderType, content, metadata = {}, createdAt = null }, log = logger) {
  const text = String(content ?? '').trim();
  if (!userId || !text) return null;
  if (!DIRECTIONS.includes(direction) || !SENDER_TYPES.includes(senderType)) {
    log.warn('messages.invalid', { direction, sender_type: senderType });
    return null;
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO messages (user_id, direction, sender_type, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, direction, sender_type, content, metadata, created_at`,
      [userId, direction, senderType, text, JSON.stringify(metadata || {}), createdAt], log);
    return rows[0] || null;
  } catch (err) {
    log.warn('messages.record_failed', { message: err.message, code: err.code });
    return null;
  }
}

/** A client's inbound message. A Twilio retry (same sid) is not written twice. */
function inbound(userId, content, metadata = {}, log = logger) {
  return record({ userId, direction: 'inbound', senderType: 'user', content, metadata }, log);
}

/** Something sent to the client. senderType: 'alice' (default) or 'human_agent'. */
function outbound(userId, content, { senderType = 'alice', metadata = {} } = {}, log = logger) {
  return record({ userId, direction: 'outbound', senderType, content, metadata }, log);
}

/** A note for the chat view only. Never sent to the client. */
function system(userId, content, metadata = {}, log = logger) {
  return record({ userId, direction: 'outbound', senderType: 'system', content, metadata }, log);
}

/** The user who owns a phone number, matched on digits only. */
async function userIdForPhone(phone, log = logger) {
  const d = digits(phone);
  if (!d) return null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE regexp_replace(phone_number, '\\D', '', 'g') = $1 LIMIT 1`, [d], log);
    return rows[0]?.id || null;
  } catch (err) {
    log.warn('messages.user_lookup_failed', { message: err.message });
    return null;
  }
}

/**
 * Called by the Twilio integration after every accepted send, so no sender
 * can forget to log. `userId` is used when the caller knows it; otherwise the
 * recipient's number finds the user (an unknown number has no row: skipped).
 */
async function outboundSent({ to, userId = null, content, senderType = 'alice', metadata = {} }, log = logger) {
  try {
    const id = userId || await userIdForPhone(to, log);
    if (!id) return null;
    return await outbound(id, content, { senderType, metadata }, log);
  } catch (err) {
    log.warn('messages.outbound_log_failed', { message: err.message });
    return null;
  }
}

/** One client's messages, oldest first (the newest `limit`). */
async function listForUser(userId, { limit = 200, before = null } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { rows } = await db.query(
    `SELECT id, direction, sender_type, content, metadata, created_at
       FROM (
         SELECT id, direction, sender_type, content, metadata, created_at
           FROM messages
          WHERE user_id = $1 AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
          ORDER BY created_at DESC LIMIT $2
       ) recent
      ORDER BY created_at ASC`,
    [userId, capped, before], log);
  return rows;
}

/**
 * The inbox: every client with their last message, most recently active first.
 * `unread` is true when the client is with a human and the last word is theirs,
 * i.e. somebody on the desk owes them a reply.
 */
async function inbox({ limit = 100 } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.first_name, u.last_name, u.phone_number,
            u.conversation_mode, u.human_override_until, u.account_status, u.cohort_id,
            u.onboarding_phase,
            m.content AS last_message, m.direction AS last_direction,
            m.sender_type AS last_sender_type, m.created_at AS last_message_at
       FROM users u
       LEFT JOIN LATERAL (
         SELECT content, direction, sender_type, created_at
           FROM messages
          WHERE user_id = u.id AND sender_type <> 'system'
          ORDER BY created_at DESC LIMIT 1
       ) m ON true
      ORDER BY m.created_at DESC NULLS LAST, u.created_at DESC
      LIMIT $1`,
    [capped], log);
  return rows.map((r) => ({
    ...r,
    last_message: r.last_message == null ? null : String(r.last_message).slice(0, 160),
    unread: r.conversation_mode === 'human' && r.last_direction === 'inbound',
  }));
}

/**
 * Is the client inside Meta's 24-hour window (did they write in the last
 * 24 hours)? Outside it WhatsApp drops free text, so a human reply cannot be
 * delivered. `conversations` is checked too, for history from before 008.
 */
async function inWindow(userId, log = logger) {
  const since = `NOW() - INTERVAL '23 hours 30 minutes'`;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM messages
        WHERE user_id = $1 AND direction = 'inbound' AND created_at > ${since}
        LIMIT 1`, [userId], log);
    if (rows.length) return true;
  } catch (err) {
    log.warn('messages.window_check_failed', { message: err.message });
  }
  const { rows } = await db.query(
    `SELECT 1 FROM conversations WHERE user_id = $1 AND timestamp > ${since} LIMIT 1`, [userId], log);
  return rows.length > 0;
}

/** Was a message with this metadata flag sent to the client since `since`? */
async function sentSince(userId, flag, since, log = logger) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM messages
        WHERE user_id = $1 AND direction = 'outbound' AND metadata ? $2
          AND created_at > COALESCE($3::timestamptz, 'epoch')
        LIMIT 1`, [userId, flag, since], log);
    return rows.length > 0;
  } catch (err) {
    log.warn('messages.sent_since_failed', { message: err.message });
    return false;
  }
}

module.exports = {
  DIRECTIONS,
  SENDER_TYPES,
  AUDIO_PREFIX,
  MEDIA_PLACEHOLDER,
  VOICE_PLACEHOLDER,
  record,
  inbound,
  outbound,
  system,
  userIdForPhone,
  outboundSent,
  listForUser,
  inbox,
  inWindow,
  sentSince,
};
