/**
 * User state: the fields that drive automation and the human hand-off.
 *
 * Per the brief (2F), any change to conversation_mode, onboarding_phase or
 * next_date_due_at is pushed to Airtable immediately.
 */

const db = require('../db/pool');
const airtable = require('../integrations/airtable');
const events = require('./events');
const messages = require('./messages');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const UNDEFINED_COLUMN = '42703';

/** The line the chat view shows when the mode changes, by who changed it. */
function modeNote(mode, source) {
  const who = String(source || 'admin');
  if (mode === 'human') {
    if (who.startsWith('alice_handoff')) return 'Human mode engaged: Alice handed this client to the desk.';
    if (who.startsWith('airtable')) return 'Human mode engaged (set in Airtable).';
    if (who.startsWith('admin:')) return `Human mode engaged by ${who.slice(6)}.`;
    return 'Human mode engaged.';
  }
  if (who === 'auto_resume') return 'Alice resumed automatically: the human window ended.';
  if (who.startsWith('airtable')) return 'Alice resumed (set in Airtable).';
  if (who.startsWith('admin:')) return `Alice resumed by ${who.slice(6)}.`;
  return 'Alice resumed.';
}

const CONVERSATION_MODES = ['ai', 'human'];

/** The exact Airtable single-select options. Changing these means changing Airtable. */
const ONBOARDING_PHASES = ['Waitlist', 'Approved', 'Denied', 'Onboarded', 'Active', 'Inactive'];

const PUBLIC_COLUMNS = `
  id, first_name, last_name, phone_number, email, client_id, short_id, tier,
  subscription_status, onboarding_status, onboarding_step, onboarding_phase,
  onboarding_completed_at, conversation_mode, last_date_curated_at,
  date_night_cadence, next_date_due_at, active_timezone, active_timezone_set_at,
  calendar_connected, calendar_connected_at, calendar_timezone,
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
  // The previous mode comes back too, so the chat view gets a note only when
  // the mode really changed.
  const { rows } = await db.query(
    `WITH old AS (SELECT conversation_mode AS previous_mode FROM users WHERE id = $1)
     UPDATE users SET conversation_mode = $2, conversation_mode_changed_at = NOW()
       FROM old
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}, old.previous_mode`,
    [userId, mode], log);
  const user = rows[0];
  if (!user) return null;
  const previousMode = user.previous_mode;
  delete user.previous_mode;

  // Human mode ends by itself HUMAN_MODE_TIMEOUT_MINUTES after the last human
  // action. Its own statement, so the mode switch above still works on a
  // database that does not have the column yet (migration 008).
  user.human_override_until = await setHumanOverride(userId, mode, log);
  if (previousMode !== mode) {
    await messages.system(userId, modeNote(mode, source), { event: 'conversation_mode', mode, source }, log);
  }

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
 * Start, move or clear the human window.
 * @returns {Promise<string|null>} the new human_override_until
 */
async function setHumanOverride(userId, mode, log = logger) {
  const minutes = config.gate.humanModeTimeoutMinutes;
  try {
    const { rows } = await db.query(
      `UPDATE users
          SET human_override_until = CASE
            WHEN $2::text = 'human' AND $3::int > 0 THEN NOW() + make_interval(mins => $3::int)
            ELSE NULL END
        WHERE id = $1
        RETURNING human_override_until`,
      [userId, mode, minutes], log);
    return rows[0]?.human_override_until ?? null;
  } catch (err) {
    log.warn('user.human_override_not_set', { user_id: userId, message: err.message, code: err.code });
    return null;
  }
}

/**
 * A human just acted for a client who is already in human mode (sent a
 * message): the window starts again from now. No mode change, so no Airtable
 * push and no chat note.
 */
async function extendHumanOverride(userId, log = logger) {
  return setHumanOverride(userId, 'human', log);
}

/**
 * Users whose human window has ended.
 *
 * The window is human_override_until: set at the hand-over and moved forward
 * by every human action (a take-over, a message from the desk). A client who
 * keeps writing does NOT move it: if the desk has gone quiet for the whole
 * window, Alice takes the client back rather than leaving them unanswered.
 * Rows from before the column existed fall back to the mode-change time.
 */
async function findStaleHumanMode(minutes, log = logger) {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.phone_number
         FROM users u
        WHERE u.conversation_mode = 'human'
          AND COALESCE(u.human_override_until,
                       COALESCE(u.conversation_mode_changed_at, 'epoch') + make_interval(mins => $1::int))
              < NOW()`,
      [minutes], log);
    return rows;
  } catch (err) {
    if (err.code !== UNDEFINED_COLUMN) throw err;
    return findStaleHumanModeLegacy(minutes, log);
  }
}

/**
 * The same question before migration 008: quiet either way for `minutes`.
 * Kept so the job keeps working if the code is deployed before the SQL.
 */
async function findStaleHumanModeLegacy(minutes, log = logger) {
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
 * The Command Center's extra columns for a set of users, keyed by id.
 * Separate from PUBLIC_COLUMNS on purpose: those are read on every WhatsApp
 * message, and a column missing there would take the line down.
 * @returns {Promise<Object<string, object>>} {} when migration 008 is not applied
 */
async function commandCenterFields(userIds, log = logger) {
  if (!userIds?.length) return {};
  try {
    const { rows } = await db.query(
      `SELECT id, account_status, cohort_id, trial_duration_days, human_override_until,
              activated_at, trial_start_date,
              calendar_provider, calendar_disconnected_at, calendar_token_last_refreshed_at,
              calendar_token_status
         FROM users WHERE id = ANY($1::uuid[])`,
      [userIds], log);
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  } catch (err) {
    log.warn('user.command_center_fields_unavailable', { message: err.message, code: err.code });
    return {};
  }
}

/**
 * When the trial ends and how many days are left, from the activation date
 * (the trial start for clients never activated) and trial_duration_days.
 * @returns {{ trial_started_at, trial_ends_at, trial_days_left }|null}
 */
function trialWindow(row, now = new Date()) {
  const anchor = row?.activated_at || row?.trial_start_date;
  const days = Number(row?.trial_duration_days);
  if (!anchor || !Number.isFinite(days) || days <= 0) return null;
  const start = new Date(anchor);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + days * 86400e3);
  return {
    trial_started_at: start.toISOString(),
    trial_ends_at: end.toISOString(),
    trial_days_left: Math.ceil((end.getTime() - now.getTime()) / 86400e3),
  };
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
  modeNote,
  setHumanOverride,
  extendHumanOverride,
  commandCenterFields,
  trialWindow,
  findStaleHumanMode,
  findStaleHumanModeLegacy,
  findById,
  listRecent,
  setConversationMode,
  setOnboardingPhase,
  recordDateNight,
  setDateNightCadence,
  findDueForDateNight,
};
