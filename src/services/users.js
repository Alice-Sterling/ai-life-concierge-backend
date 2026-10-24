/**
 * User state: the fields that drive automation and the human hand-off.
 *
 * Per the brief (2F), any change to conversation_mode, onboarding_phase or
 * next_date_due_at is pushed to Airtable immediately.
 */

const db = require('../db/pool');
const airtable = require('../integrations/airtable');
const events = require('./events');
const { logger } = require('../lib/logger');

const CONVERSATION_MODES = ['ai', 'human'];

/** The exact Airtable single-select options. Changing these means changing Airtable. */
const ONBOARDING_PHASES = ['Waitlist', 'Approved', 'Denied', 'Onboarded', 'Active', 'Inactive'];

const PUBLIC_COLUMNS = `
  id, first_name, last_name, phone_number, email, client_id, short_id, tier,
  subscription_status, onboarding_status, onboarding_step, onboarding_phase,
  onboarding_completed_at, conversation_mode, last_date_curated_at,
  date_night_cadence, next_date_due_at, active_timezone, active_timezone_set_at,
  welcome_message_sent, conversation_mode_changed_at, created_at
`;

/**
 * Map whatever is typed in Airtable's Status cell to one of ONBOARDING_PHASES.
 * "On boarded", "onboarded" and "ACTIVE " all count; anything else is null.
 */
function normalizePhase(raw) {
  if (raw == null) return null;
  const key = String(Array.isArray(raw) ? raw[0] : raw).toLowerCase().replace(/[^a-z]/g, '');
  return ONBOARDING_PHASES.find((p) => p.toLowerCase() === key) || null;
}

async function findById(userId, log = logger) {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [userId], log);
  return rows[0] || null;
}

/** Recent users, newest first. Used by GET /admin/users. */
async function listRecent({ limit = 50 } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC LIMIT $1`, [capped], log);
  return rows;
}

/**
 * Switch a user between the agent and a human operator.
 *
 * This is the manual override behind POST /admin/users/:userId/mode. While a
 * user is in 'human' mode the webhook queues their messages instead of replying.
 */
async function setConversationMode(userId, mode, { requestId = null, source = 'admin' } = {}, log = logger) {
  if (!CONVERSATION_MODES.includes(mode)) {
    throw Object.assign(new Error(`Invalid conversation_mode: ${mode}`), { status: 400 });
  }

  // The timestamp starts the auto-resume clock (src/jobs/humanModeResume.js).
  const { rows } = await db.query(
    `UPDATE users SET conversation_mode = $2, conversation_mode_changed_at = NOW()
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [userId, mode], log);
  const user = rows[0];
  if (!user) return null;

  log.info('user.conversation_mode_changed', { user_id: userId, conversation_mode: mode, source });
  await events.record(events.EVENT.CONVERSATION_MODE_CHANGED, {
    userId, requestId, metadata: { conversation_mode: mode, source },
  }, log);

  await pushToAirtable(user, log);
  return user;
}

/**
 * Set the Airtable-facing status. Rejects anything outside the agreed options.
 *
 * `fromAirtable` skips the push back: when the change was read from Airtable,
 * writing it back is a wasted call at best and a race with the operator at worst.
 */
async function setOnboardingPhase(userId, phase, { requestId = null, fromAirtable = false } = {}, log = logger) {
  if (!ONBOARDING_PHASES.includes(phase)) {
    throw Object.assign(
      new Error(`Invalid onboarding_phase: ${phase}. Expected one of: ${ONBOARDING_PHASES.join(', ')}`),
      { status: 400 }
    );
  }

  // onboarding_completed_at is stamped once, on the first transition into a
  // completed state, and left alone afterwards so the original date survives
  // a later status change.
  const { rows } = await db.query(
    `UPDATE users
        SET onboarding_phase = $2::varchar,
            onboarding_completed_at = CASE
              WHEN $2::varchar IN ('Onboarded', 'Active') AND onboarding_completed_at IS NULL THEN NOW()
              ELSE onboarding_completed_at END
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, phase], log);
  const user = rows[0];
  if (!user) return null;

  log.info('user.onboarding_phase_changed', { user_id: userId, onboarding_phase: phase, from_airtable: fromAirtable });
  if (phase === 'Onboarded') {
    await events.record(events.EVENT.ONBOARDING_COMPLETED, { userId, requestId }, log);
  }

  if (!fromAirtable) await pushToAirtable(user, log);
  return user;
}

/**
 * Claim the one-off welcome. Returns true only for the caller that flipped the
 * flag, so two paths racing (Stripe and the inbound gate) cannot both send it.
 */
async function claimWelcome(userId, log = logger) {
  const { rowCount } = await db.query(
    `UPDATE users SET welcome_message_sent = true
      WHERE id = $1 AND welcome_message_sent = false`,
    [userId], log);
  return rowCount === 1;
}

/**
 * Users in human mode with no activity either way for `minutes`.
 *
 * Activity is the later of the hand-off itself and the last message in the
 * conversation, so a client still talking to the desk is not handed back
 * mid-thread. Operator replies sent outside this service (the Twilio console)
 * are not visible here.
 */
async function findStaleHumanMode(minutes, log = logger) {
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.phone_number
       FROM users u
       LEFT JOIN LATERAL (
         SELECT MAX(c.timestamp) AS last_ts FROM conversations c WHERE c.user_id = u.id
       ) last ON true
      WHERE u.conversation_mode = 'human'
        AND GREATEST(COALESCE(u.conversation_mode_changed_at, 'epoch'),
                     COALESCE(last.last_ts, 'epoch'))
            < NOW() - make_interval(mins => $1::int)`,
    [minutes], log);
  return rows;
}

/**
 * Record a date-night curation and schedule the next one.
 *
 * next_date_due_at is computed in SQL from the cadence so the value cannot drift
 * from its inputs, and is left NULL when the user has no cadence set — the cron's
 * index only covers non-null rows.
 */
async function recordDateNight(userId, { curatedAt = null, requestId = null } = {}, log = logger) {
  const { rows } = await db.query(
    `UPDATE users
        SET last_date_curated_at = COALESCE($2::timestamptz, NOW()),
            next_date_due_at = CASE
              WHEN date_night_cadence IS NULL THEN NULL
              ELSE COALESCE($2::timestamptz, NOW()) + (date_night_cadence || ' days')::interval END
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, curatedAt], log);
  const user = rows[0];
  if (!user) return null;

  log.info('user.date_night_recorded', { user_id: userId, next_date_due_at: user.next_date_due_at });
  await pushToAirtable(user, log);
  return user;
}

/** Set the cadence in days, recomputing the next due date from the last curation. */
async function setDateNightCadence(userId, cadenceDays, log = logger) {
  const days = Number.parseInt(cadenceDays, 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw Object.assign(new Error('date_night_cadence must be between 1 and 365 days'), { status: 400 });
  }

  const { rows } = await db.query(
    `UPDATE users
        SET date_night_cadence = $2::int,
            next_date_due_at = CASE
              WHEN last_date_curated_at IS NULL THEN NULL
              ELSE last_date_curated_at + make_interval(days => $2::int) END
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, days], log);
  const user = rows[0];
  if (!user) return null;

  await pushToAirtable(user, log);
  return user;
}

/** Users whose next date night has come due. Read by the date-night cron. */
async function findDueForDateNight({ limit = 100, userId = null } = {}, log = logger) {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users
      WHERE next_date_due_at IS NOT NULL AND next_date_due_at <= NOW()
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY next_date_due_at ASC LIMIT $1`,
    [Math.min(Number(limit) || 100, 500), userId], log);
  return rows;
}

/** Best-effort mirror to Airtable. Never throws into the caller. */
async function pushToAirtable(user, log = logger) {
  if (!airtable.isConfigured()) return;
  try {
    await airtable.syncUser(user, log);
  } catch (err) {
    log.warn('user.airtable_sync_failed', { user_id: user.id, message: err.message });
  }
}

module.exports = {
  CONVERSATION_MODES,
  ONBOARDING_PHASES,
  normalizePhase,
  claimWelcome,
  findStaleHumanMode,
  findById,
  listRecent,
  setConversationMode,
  setOnboardingPhase,
  recordDateNight,
  setDateNightCadence,
  findDueForDateNight,
};
