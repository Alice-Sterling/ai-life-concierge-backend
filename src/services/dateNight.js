/**
 * The date-night loop.
 *
 * Alice pitches date_night as "bi-weekly recommendations". Until now nothing
 * delivered them: intake saved the preferences and the schedule columns
 * (date_night_cadence, next_date_due_at) were never written or read.
 *
 * This closes the loop:
 *
 *   intake  -> scheduleAfterIntake()  sets the cadence and the first due date
 *   due     -> runDueSweep()          raises an operator task with a ready brief
 *   done    -> onTaskCompleted()      records the curation, schedules the next
 *
 * The due step creates a task for a human rather than messaging the client.
 * That is deliberate: a proactive WhatsApp message outside the 24-hour window
 * needs a Meta-approved template, which does not exist yet. A human with a
 * prepared brief can act today, and the task trail is the audit log either way.
 *
 * Everything here is deterministic. No LLM call: deciding WHO is due and WHAT
 * they asked for is a database question, and getting it wrong should be
 * impossible rather than unlikely.
 */

const db = require('../db/pool');
const tasks = require('./tasks');
const events = require('./events');
const users = require('./users');
const templates = require('./templates');
const { config } = require('../config');
const { logger } = require('../lib/logger');

/** "Bi-weekly" is what Alice promises, so it is the default. */
const DEFAULT_CADENCE_DAYS = 14;
const MIN_CADENCE_DAYS = 3;
const MAX_CADENCE_DAYS = 90;

const OPERATOR_EMAIL = 'assist@ailifeconcierge.co.uk';

function normaliseCadence(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_CADENCE_DAYS;
  return Math.min(Math.max(n, MIN_CADENCE_DAYS), MAX_CADENCE_DAYS);
}

/**
 * Called once date-night intake completes.
 *
 * Sets the cadence and, if nothing is scheduled yet, the first due date one
 * cadence from now: intake usually ends with Alice suggesting tonight's options
 * in the same conversation, so the first proactive brief should follow the
 * client's rhythm rather than land on top of that.
 *
 * Re-running intake updates the cadence but keeps an existing due date, so
 * editing preferences never silently pushes a planned date back.
 */
async function scheduleAfterIntake(userId, cadenceDays, log = logger) {
  const cadence = normaliseCadence(cadenceDays);
  const { rows } = await db.query(
    `UPDATE users
        SET date_night_cadence = $2::int,
            next_date_due_at = COALESCE(next_date_due_at, NOW() + make_interval(days => $2::int))
      WHERE id = $1
      RETURNING id, date_night_cadence, next_date_due_at`,
    [userId, cadence],
    log
  );
  if (!rows[0]) return null;

  log.info('date_night.scheduled', {
    user_id: userId, cadence_days: cadence, next_date_due_at: rows[0].next_date_due_at,
  });
  return rows[0];
}

/**
 * Venues from the Black Book that fit the client's stated area.
 *
 * Plain matching on purpose. The table is small and curated; when there is no
 * match the brief says so, which tells the operator exactly where the vault
 * has a gap instead of papering over it with a guess.
 */
async function findVaultMatches(neighbourhood, log = logger) {
  if (!neighbourhood) return [];
  const { rows } = await db.query(
    `SELECT name, location, booking_url, description
       FROM recommendations
      WHERE location ILIKE '%' || $1 || '%'
         OR $1 ILIKE '%' || location || '%'
      ORDER BY name
      LIMIT 3`,
    [neighbourhood],
    log
  );
  return rows;
}

/** The brief an operator needs to act without opening anything else. */
function buildBrief(user, prefs, matches) {
  const lines = [
    `Date night due for ${user.first_name || 'client'} (every ${user.date_night_cadence} days).`,
    '',
    `Area: ${prefs.neighborhood || 'not given'}`,
    `Budget: ${prefs.budget || 'not given'}`,
    `Cuisines: ${(prefs.cuisines || []).join(', ') || 'not given'}`,
    `Dietary: ${(prefs.dietary_restrictions || []).join(', ') || 'none stated'}`,
    `Client timezone: ${user.active_timezone || 'Europe/London'}`,
    '',
  ];

  if (matches.length) {
    lines.push('Vault matches:');
    for (const m of matches) lines.push(`- ${m.name} (${m.location}) ${m.booking_url || ''}`.trim());
  } else {
    lines.push(`No vetted venues in the vault for "${prefs.neighborhood || 'this area'}". Research needed, then add the pick to the Black Book.`);
  }

  lines.push('', 'Next: propose 2-3 options for a free evening, then mark this task completed.');
  return lines.join('\n');
}

async function hasOpenDateNightTask(userId, log = logger) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks
      WHERE user_id = $1 AND category = 'date_night'
        AND status IN ('new', 'triaged', 'in_progress')
      LIMIT 1`,
    [userId],
    log
  );
  return rows.length > 0;
}

/**
 * Raise a task for every client whose date night has come due.
 *
 * Idempotent: a client with an open date-night task is skipped, so an hourly
 * sweep never stacks duplicates while the operator is still working one.
 *
 * @returns {Promise<{due: number, created: number, skipped: number, failed: number}>}
 */
/** The client's local hour, 0-23. */
function localHour(timezone, now = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric', hourCycle: 'h23', timeZone: timezone || 'Europe/London',
    }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Ping mode (Project 3, Flow 1): ask the client first, with Review / Skip
 * buttons, instead of handing the desk a task. The cycle moves on when the
 * ping goes out, so ignoring it costs the client one cycle, not a daily ping.
 *
 * @returns {Promise<boolean>} false when the ping could not be delivered
 *   (no approved template and the client is outside the 24-hour window)
 */
async function sendPing(user, log) {
  const inWindow = await templates.inWindow(user.id, log);
  if (!config.templates.datenight_ping && !inWindow) return false;

  const sent = await templates.send('datenight_ping', { to: user.phone_number, user, inWindow }, log);
  if (!sent.sent || sent.via === 'inline') return false;

  await db.query(
    `UPDATE users
        SET next_date_due_at = NOW() + make_interval(days => COALESCE(date_night_cadence, $2)::int)
      WHERE id = $1`,
    [user.id, DEFAULT_CADENCE_DAYS], log);
  await events.record('date_night_pinged', {
    userId: user.id, metadata: { cadence_days: user.date_night_cadence, via: sent.via },
  }, log);
  return true;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.userId]     only this client (the admin test tool)
 * @param {boolean} [opts.ignoreHour] ping now, not in the client's morning (test tool only)
 */
async function runDueSweep(log = logger, { now = new Date(), userId = null, ignoreHour = false } = {}) {
  const due = await users.findDueForDateNight({ limit: 100, userId }, log);
  const result = { due: due.length, created: 0, pinged: 0, skipped: 0, failed: 0 };
  const pingMode = config.lifecycle.dateNightPing;

  for (const u of due) {
    // Pings go out in the client's own morning; until then they simply wait.
    if (pingMode && !ignoreHour && localHour(u.active_timezone, now) !== config.lifecycle.dateNightPingHour) {
      result.skipped += 1;
      continue;
    }
    const userLog = log.child({ user_id: u.id });
    const logId = await events.logAutomation('date_night_cron', 'pending', { userId: u.id }, userLog);

    try {
      if (await hasOpenDateNightTask(u.id, userLog)) {
        result.skipped += 1;
        await events.completeAutomation(logId, 'success', 'skipped: open date_night task exists', userLog);
        continue;
      }

      const { rows } = await db.query(
        'SELECT preferences, active_timezone FROM users WHERE id = $1', [u.id], userLog);
      const prefs = rows[0]?.preferences?.date_night || {};
      const user = { ...u, active_timezone: rows[0]?.active_timezone, preferences: rows[0]?.preferences || {} };

      if (pingMode && await sendPing(user, userLog)) {
        await events.completeAutomation(logId, 'success', 'pinged', userLog);
        result.pinged += 1;
        continue;
      }
      // Ping mode off, or the ping could not be delivered: the desk gets the brief.
      const matches = await findVaultMatches(prefs.neighborhood, userLog);

      await tasks.create({
        userId: u.id,
        sourceMessage: null,
        aiSummary: buildBrief(user, prefs, matches),
        category: 'date_night',
        priority: 'normal',
        requiresHuman: true,
        assignedTo: OPERATOR_EMAIL,
      }, userLog);

      await events.record('date_night_due', {
        userId: u.id, metadata: { cadence_days: u.date_night_cadence, vault_matches: matches.length },
      }, userLog);
      await events.completeAutomation(logId, 'success', null, userLog);
      result.created += 1;
    } catch (err) {
      result.failed += 1;
      userLog.error('date_night.sweep_user_failed', { message: err.message });
      await events.completeAutomation(logId, 'failed', err.message, userLog);
    }
  }

  log.info('date_night.sweep_done', result);
  return result;
}

/**
 * When the operator closes a date-night task, the date has been curated:
 * record it and schedule the next one from the client's cadence.
 */
async function onTaskCompleted(task, log = logger) {
  if (!task || task.category !== 'date_night' || task.status !== 'completed') return null;
  const user = await users.recordDateNight(task.user_id, {}, log);
  if (user) {
    log.info('date_night.next_scheduled', { user_id: task.user_id, next_date_due_at: user.next_date_due_at });
  }
  return user;
}

module.exports = {
  DEFAULT_CADENCE_DAYS,
  normaliseCadence,
  scheduleAfterIntake,
  findVaultMatches,
  buildBrief,
  localHour,
  runDueSweep,
  onTaskCompleted,
};
