/**
 * Travel-aware timezone.
 *
 * The agent's prompt used to hard-code Europe/London, so Alice assumed London
 * time for every client. This is the per-user override: she reads it on every
 * message and updates it herself when a client mentions travelling.
 */

const db = require('../db/pool');
const events = require('./events');
const { logger } = require('../lib/logger');

const DEFAULT_TIMEZONE = 'Europe/London';

/**
 * Is this a timezone Node can actually format with?
 *
 * Validated against the runtime's own timezone database rather than a fixed
 * list, so it stays correct as zones are added or renamed. Checking here as
 * well as in the database CHECK means the agent gets a useful error back
 * rather than a constraint violation.
 */
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  const name = tz.trim();

  // Intl accepts offsets like "+04:00", Postgres does not, so without this the
  // app would approve a value the database then rejects. An offset is wrong
  // anyway: it cannot follow daylight saving, so it silently drifts an hour
  // twice a year. Only IANA names are allowed.
  if (/^[+-]\d{2}(:?\d{2})?$/.test(name)) return false;

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format "now" for a user, for the agent's system prompt.
 * Falls back to London if the stored zone is somehow unusable, so a bad value
 * degrades to the old behaviour instead of breaking the prompt.
 */
function formatNowFor(timezone) {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return {
    timezone: tz,
    localTime: new Date().toLocaleString('en-GB', { timeZone: tz }),
    utcOffset: new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? '',
  };
}

/**
 * Set a user's active timezone.
 * @returns {Promise<{timezone: string, localTime: string}|null>} null if no such user
 */
async function setForUser(userId, timezone, { requestId = null } = {}, log = logger) {
  const tz = String(timezone || '').trim();

  if (!isValidTimezone(tz)) {
    throw Object.assign(
      new Error(`Not a valid IANA timezone: "${timezone}". Expected something like Europe/London or Asia/Dubai.`),
      { status: 400 }
    );
  }

  const { rows } = await db.query(
    `UPDATE users
        SET active_timezone = $2,
            active_timezone_set_at = NOW()
      WHERE id = $1
      RETURNING id, active_timezone`,
    [userId, tz],
    log
  );
  if (!rows[0]) return null;

  log.info('user.timezone_changed', { user_id: userId, active_timezone: tz });
  await events.record('timezone_changed', {
    userId, requestId, metadata: { active_timezone: tz },
  }, log);

  return formatNowFor(tz);
}

/**
 * The Anthropic tool definition. Given to the agent so it can handle travel
 * itself rather than looping back to a human.
 */
const SET_TIMEZONE_TOOL = {
  name: 'set_active_timezone',
  description:
    'Update the timezone the client is currently in. Call this as soon as they mention travelling, '
    + 'landing somewhere, or a local time that does not match their current timezone. '
    + 'All later scheduling and time references use it. '
    + 'Takes an IANA timezone name such as Europe/London, Asia/Dubai, America/New_York. '
    + 'Call it again with their home timezone when they return.',
  input_schema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name, e.g. Asia/Dubai. Never a UTC offset such as +04:00.',
      },
      reason: {
        type: 'string',
        description: 'Short note on why it changed, e.g. "client flying to Dubai until Friday".',
      },
    },
    required: ['timezone'],
  },
};

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  formatNowFor,
  setForUser,
  SET_TIMEZONE_TOOL,
};
