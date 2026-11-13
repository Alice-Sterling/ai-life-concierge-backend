/**
 * One proactive send per client, template and period (Project 4).
 *
 * The proactive jobs already ask "did I send this?" by reading
 * outbound_messages. That check and the send are two steps, so two instances,
 * or a job retried after a crash, can both pass the check and both send.
 * A row in proactive_send_locks is claimed BEFORE the send; its unique key
 * (user_id, template_key, period_key) lets only one caller through.
 *
 * period_key says what "the same send" means: an ISO week for the weekly
 * briefing, the due date for date night, the event for a milestone.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const UNDEFINED_TABLE = '42P01';

/**
 * Claim the send.
 * @returns {Promise<boolean>} true = go ahead; false = somebody already sent it.
 *   Before migration 008 the table does not exist: that answers true, so the
 *   jobs behave exactly as they did (their own outbound_messages check stays).
 */
async function claim(userId, templateKey, periodKey, log = logger) {
  if (!userId || !templateKey || !periodKey) return true;
  try {
    const { rowCount } = await db.query(
      `INSERT INTO proactive_send_locks (user_id, template_key, period_key)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT proactive_send_locks_unique DO NOTHING`,
      [userId, templateKey, String(periodKey).slice(0, 128)], log);
    if (rowCount === 0) log.info('send_lock.duplicate_blocked', { user_id: userId, template: templateKey, period: periodKey });
    return rowCount === 1;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return true;
    throw err;
  }
}

/** Give the claim back after a send that Twilio refused, so the next run can retry. */
async function release(userId, templateKey, periodKey, log = logger) {
  if (!userId || !templateKey || !periodKey) return;
  try {
    await db.query(
      `DELETE FROM proactive_send_locks WHERE user_id = $1 AND template_key = $2 AND period_key = $3`,
      [userId, templateKey, String(periodKey).slice(0, 128)], log);
  } catch (err) {
    log.warn('send_lock.release_failed', { message: err.message });
  }
}

/** "2026-W46": the ISO week of a date, for weekly sends. */
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "2026-11-13": the calendar day, for sends that may happen once a day. */
const isoDay = (date = new Date()) => new Date(date).toISOString().slice(0, 10);

module.exports = { claim, release, isoWeek, isoDay };
