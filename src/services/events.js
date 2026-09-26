/**
 * Product funnel events and automation audit logs.
 *
 * Both live only in Postgres. They are never pushed to Airtable — see the brief,
 * section 2F: syncing append-only tables would exhaust the Airtable quota with
 * rows no operator reads.
 *
 * Recording is best-effort. Losing a funnel event is acceptable; failing a
 * customer's message because analytics threw is not.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

/** Known funnel events. Free-form strings are allowed, but drift is the enemy. */
const EVENT = {
  PORTAL_VIEWED: 'portal_viewed',
  WHATSAPP_STARTED: 'whatsapp_started',
  ONBOARDING_COMPLETED: 'onboarding_completed',
  HUMAN_HANDOFF_CREATED: 'human_handoff_created',
  CONVERSATION_MODE_CHANGED: 'conversation_mode_changed',
  SUBSCRIPTION_UPGRADED: 'subscription_upgraded',
};

/**
 * Record a funnel event.
 * @param {string}  eventName
 * @param {object} [opts]
 * @param {string} [opts.userId]    null for events that precede identification
 * @param {object} [opts.metadata]
 * @param {string} [opts.requestId]
 */
async function record(eventName, { userId = null, metadata = {}, requestId = null } = {}, log = logger) {
  try {
    await db.query(
      `INSERT INTO events (user_id, event_name, metadata, request_id)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [userId, eventName, JSON.stringify(metadata), requestId],
      log
    );
  } catch (err) {
    log.warn('events.record_failed', { event_name: eventName, message: err.message });
  }
}

/**
 * Record the outcome of an automation run.
 * @param {string} automationType e.g. date_night_cron, client_event_webhook
 * @param {'success'|'failed'|'pending'} status
 */
async function logAutomation(
  automationType,
  status,
  { userId = null, errorDetails = null, requestId = null } = {},
  log = logger
) {
  try {
    const { rows } = await db.query(
      `INSERT INTO automation_logs (user_id, automation_type, status, error_details, request_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING log_id`,
      [userId, automationType, status, errorDetails, requestId],
      log
    );
    return rows[0]?.log_id ?? null;
  } catch (err) {
    log.warn('automation_logs.write_failed', { automation_type: automationType, message: err.message });
    return null;
  }
}

/** Flip a pending automation log to its final state once the run completes. */
async function completeAutomation(logId, status, errorDetails = null, log = logger) {
  if (!logId) return;
  try {
    await db.query(
      'UPDATE automation_logs SET status = $2, error_details = $3 WHERE log_id = $1',
      [logId, status, errorDetails],
      log
    );
  } catch (err) {
    log.warn('automation_logs.update_failed', { log_id: logId, message: err.message });
  }
}

module.exports = { EVENT, record, logAutomation, completeAutomation };
