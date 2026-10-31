/**
 * Proactive flows from the brief that start with a ping (Project 3):
 *
 *   Flow 2 runWeeklyBriefings()  Sunday 18:00 (client's time): "any client dinners or events this week?"
 *   Flow 3 runMilestonePings()   a birthday / anniversary in the calendar about three weeks ahead
 *   Flow 4 runTransitPings()     a flight in the calendar up to 14 days ahead: "uber, or rail?"
 *   Flow 6 runTravelPings()      a multi-day trip up to 14 days ahead: dining + experiences there
 *
 * Both run inside the 15-minute lifecycle job, each behind its own switch,
 * and send through templates.send() so outbound_messages is the record of
 * what went out. The answers to their buttons are in proactiveReplies.js.
 *
 * Calendar privacy (brief, Flow 3): the scan reads event titles here only to
 * spot the occasion. Alice and the stored record get the occasion type and the
 * date, never the title.
 */

const crypto = require('crypto');
const db = require('../db/pool');
const { config } = require('../config');
const templates = require('./templates');
const events = require('./events');
const calendar = require('./calendar');
const flights = require('./flights');
const trips = require('./trips');
const promptContext = require('./promptContext');
const { logger } = require('../lib/logger');

const DAY_MS = 86400e3;

/** A weekly briefing is not sent twice within this many days. */
const WEEKLY_REPEAT_DAYS = 6;

/** Days either side of "three weeks ahead" that the milestone scan looks at. */
const MILESTONE_WINDOW_DAYS = 2;

/** Title words -> the occasion named in the ping ({{9}}). First match wins. */
const MILESTONES = [
  [/\b(birthday|b-?day)\b/i, 'birthday'],
  [/\banniversary\b/i, 'anniversary'],
  [/\bwedding\b/i, 'wedding'],
  [/\bengagement\b/i, 'engagement'],
  [/\bgraduation\b/i, 'graduation'],
  [/\b(christening|baptism)\b/i, 'christening'],
  [/\bbaby shower\b/i, 'baby shower'],
  [/\bretirement\b/i, 'retirement'],
];

/** The occasion an event title names, or null. */
function detectMilestone(title) {
  const t = String(title || '');
  for (const [re, type] of MILESTONES) if (re.test(t)) return type;
  return null;
}

/** Day of week (0 = Sunday) and hour (0-23) in a timezone. */
function localDayHour(timezone, now = new Date()) {
  const fmt = (opts, tz) => new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(now);
  let tz = timezone || 'Europe/London';
  try {
    fmt({ hour: 'numeric' }, tz);
  } catch {
    tz = 'Europe/London';
  }
  const weekday = fmt({ weekday: 'short' }, tz);
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday),
    hour: Number(fmt({ hour: 'numeric', hourCycle: 'h23' }, tz)),
  };
}

/** A stable id for one calendar occurrence that does not reveal its title. */
function eventKey(event) {
  return crypto.createHash('sha256')
    .update(`${event.title}|${String(event.start || '').slice(0, 10)}`)
    .digest('hex').slice(0, 32);
}

/**
 * Flow 2. Every Active client in AI mode, once a week, at the configured day
 * and hour in their own timezone.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]     only this client (admin test tool)
 * @param {boolean} [opts.ignoreHour] send now, whatever the day and hour (test tool only)
 */
async function runWeeklyBriefings(log = logger, { userId = null, ignoreHour = false, now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
      WHERE u.onboarding_phase = 'Active'
        AND COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND ($1::uuid IS NULL OR u.id = $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'weekly_briefing'
                           AND o.created_at > NOW() - make_interval(days => $2::int))
      LIMIT 200`,
    [userId, WEEKLY_REPEAT_DAYS], log);

  const result = { candidates: rows.length, sent: 0, skipped: 0 };
  for (const u of rows) {
    const local = localDayHour(u.active_timezone, now);
    if (!ignoreHour && (local.day !== config.lifecycle.weeklyBriefingDay
        || local.hour !== config.lifecycle.weeklyBriefingHour)) {
      continue;
    }
    const userLog = log.child({ user_id: u.id });
    const inWindow = await templates.inWindow(u.id, userLog);
    if (!config.templates.weekly_briefing && !inWindow) { result.skipped += 1; continue; }
    const sent = await templates.send('weekly_briefing', { to: u.phone_number, user: u, inWindow }, userLog);
    if (sent.sent) {
      result.sent += 1;
      await events.record('weekly_briefing_pinged', { userId: u.id, metadata: { via: sent.via } }, userLog);
    }
  }
  log.info('flows.weekly_briefings_done', result);
  return result;
}

/**
 * Flow 3. Active clients with a connected calendar: look about three weeks
 * ahead for a birthday, anniversary or similar, and offer to arrange it.
 * One ping per occasion, and at most one ping per client per day.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]     only this client (admin test tool)
 * @param {boolean} [opts.ignoreHour] run now, not at the configured local hour (test tool only)
 * @param {number} [opts.windowDays]  test tool: scan from now to this many days ahead instead
 */
async function runMilestonePings(log = logger, {
  userId = null, ignoreHour = false, windowDays = null, now = new Date(),
} = {}) {
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
      WHERE u.onboarding_phase = 'Active'
        AND COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND u.calendar_connected = true
        AND ($1::uuid IS NULL OR u.id = $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'milestone_ping'
                           AND o.created_at > NOW() - INTERVAL '20 hours')
      LIMIT 200`,
    [userId], log);

  const ahead = config.lifecycle.milestoneDaysAhead;
  const from = windowDays ? now : new Date(now.getTime() + (ahead - MILESTONE_WINDOW_DAYS) * DAY_MS);
  const to = windowDays
    ? new Date(now.getTime() + windowDays * DAY_MS)
    : new Date(now.getTime() + (ahead + MILESTONE_WINDOW_DAYS) * DAY_MS);

  const result = { candidates: rows.length, scanned: 0, found: 0, sent: 0, skipped: 0, failed: 0 };
  for (const u of rows) {
    if (!ignoreHour && localDayHour(u.active_timezone, now).hour !== config.lifecycle.milestonePingHour) continue;
    const userLog = log.child({ user_id: u.id });

    const cal = await calendar.readEvents(u.id, from, to, userLog, { includeFree: true });
    if (!cal.ok) { result.failed += 1; userLog.warn('flows.milestone_scan_failed', { reason: cal.reason }); continue; }
    result.scanned += 1;

    let pick = null;
    for (const ev of cal.events) {
      const type = detectMilestone(ev.title);
      if (!type) continue;
      const key = eventKey(ev);
      const { rows: seen } = await db.query(
        `SELECT 1 FROM events
          WHERE user_id = $1 AND event_name = 'milestone_pinged' AND metadata->>'event_key' = $2::text
          LIMIT 1`,
        [u.id, key], userLog);
      if (!seen.length) { pick = { type, key, date: String(ev.start || '').slice(0, 10) }; break; }
    }
    if (!pick) continue;
    result.found += 1;

    const inWindow = await templates.inWindow(u.id, userLog);
    if (!config.templates.milestone_ping && !inWindow) { result.skipped += 1; continue; }
    const sent = await templates.send('milestone_ping', {
      to: u.phone_number, user: u, inWindow, data: { eventType: pick.type },
    }, userLog);
    if (sent.sent) {
      result.sent += 1;
      await events.record('milestone_pinged', {
        userId: u.id, metadata: { event_key: pick.key, event_type: pick.type, event_date: pick.date, via: sent.via },
      }, userLog);
    }
  }
  log.info('flows.milestone_pings_done', result);
  return result;
}

/**
 * Flow 4 part 1. Active clients with a connected calendar: a flight from
 * tomorrow up to TRANSIT_DAYS_AHEAD days out -> ailc_transit_ping_v2
 * ("traveling to {{18}} on {{10}}: an uber, or rail?"). One ping per flight,
 * at most one transit ping per client per day. The flight details (number,
 * destination, departure time and airport) are stored with the ping so the
 * [Uber] answer can give Alice what she needs; the event title is not.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]     only this client (admin test tool)
 * @param {boolean} [opts.ignoreHour] run now, not at the configured local hour (test tool only)
 * @param {boolean} [opts.ignoreWait] skip the one-ping-a-day rule (test tool only; one ping per flight still holds)
 */
async function runTransitPings(log = logger, {
  userId = null, ignoreHour = false, ignoreWait = false, now = new Date(),
} = {}) {
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
      WHERE u.onboarding_phase = 'Active'
        AND COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND u.calendar_connected = true
        AND ($1::uuid IS NULL OR u.id = $1::uuid)
        AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'transit_ping'
                           AND o.created_at > NOW() - INTERVAL '20 hours'))
      LIMIT 200`,
    [userId, Boolean(ignoreWait)], log);

  // From "now" so a flight later today is still offered a car; up to N days out.
  const from = now;
  const to = new Date(now.getTime() + config.lifecycle.transitDaysAhead * DAY_MS);

  const result = { candidates: rows.length, scanned: 0, found: 0, sent: 0, skipped: 0, failed: 0 };
  for (const u of rows) {
    if (!ignoreHour && localDayHour(u.active_timezone, now).hour !== config.lifecycle.transitPingHour) continue;
    const userLog = log.child({ user_id: u.id });

    const cal = await calendar.readEvents(u.id, from, to, userLog, { includeFree: true, withLocation: true });
    if (!cal.ok) { result.failed += 1; userLog.warn('flows.transit_scan_failed', { reason: cal.reason }); continue; }
    result.scanned += 1;

    let pick = null;
    for (const ev of cal.events) {
      const flight = flights.detectFlight(ev);
      if (!flight) continue;
      const key = eventKey(ev);
      const { rows: seen } = await db.query(
        `SELECT 1 FROM events
          WHERE user_id = $1 AND event_name = 'transit_pinged' AND metadata->>'event_key' = $2::text
          LIMIT 1`,
        [u.id, key], userLog);
      if (!seen.length) { pick = { ...flight, key, start: ev.start, allDay: Boolean(ev.all_day) }; break; }
    }
    if (!pick) continue;
    result.found += 1;

    const inWindow = await templates.inWindow(u.id, userLog);
    if (!config.templates.transit_ping && !inWindow) { result.skipped += 1; continue; }
    const date = flights.ordinalDate(pick.start, u.active_timezone);
    const sent = await templates.send('transit_ping', {
      to: u.phone_number, user: u, inWindow, data: { destination: pick.destination || pick.flight, date },
    }, userLog);
    if (sent.sent) {
      result.sent += 1;
      await events.record('transit_pinged', {
        userId: u.id,
        metadata: {
          event_key: pick.key,
          flight: pick.flight,
          destination: pick.destination,
          from_airport: pick.from,
          departs: pick.allDay ? String(pick.start).slice(0, 10) : pick.start,
          via: sent.via,
        },
      }, userLog);
    }
  }
  log.info('flows.transit_pings_done', result);
  return result;
}

/** YYYY-MM-DD of an event boundary in the client's timezone (all-day dates are already local). */
function localDate(value, tz, allDay = false) {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value).slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/London' }).format(new Date(value));
  } catch {
    return String(value).slice(0, 10);
  }
}

/**
 * Flow 6. Active clients with a connected calendar: a multi-day event up to
 * TRAVEL_DAYS_AHEAD days out with an airport code, or more than 50 miles from
 * their home city -> ailc_travel_ping_v1 ("heading to {{18}} soon"). One ping
 * per trip, at most one travel ping per client per day. The destination and
 * trip dates are stored with the ping for the [Ready] answer.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]     only this client (admin test tool)
 * @param {boolean} [opts.ignoreHour] run now, not at the configured local hour (test tool only)
 * @param {boolean} [opts.ignoreWait] skip the one-ping-a-day rule (test tool only; one ping per trip still holds)
 */
async function runTravelPings(log = logger, {
  userId = null, ignoreHour = false, ignoreWait = false, now = new Date(),
} = {}) {
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
      WHERE u.onboarding_phase = 'Active'
        AND COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND u.calendar_connected = true
        AND ($1::uuid IS NULL OR u.id = $1::uuid)
        AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'travel_ping'
                           AND o.created_at > NOW() - INTERVAL '20 hours'))
      LIMIT 200`,
    [userId, Boolean(ignoreWait)], log);

  const from = now;
  const to = new Date(now.getTime() + config.lifecycle.travelDaysAhead * DAY_MS);

  const result = { candidates: rows.length, scanned: 0, found: 0, sent: 0, skipped: 0, failed: 0 };
  for (const u of rows) {
    if (!ignoreHour && localDayHour(u.active_timezone, now).hour !== config.lifecycle.travelPingHour) continue;
    const userLog = log.child({ user_id: u.id });

    const cal = await calendar.readEvents(u.id, from, to, userLog, { includeFree: true, withLocation: true });
    if (!cal.ok) { result.failed += 1; userLog.warn('flows.travel_scan_failed', { reason: cal.reason }); continue; }
    result.scanned += 1;

    // Only events that start inside the window: a trip already under way is not "heading to".
    const home = promptContext.homeCity(u);
    let pick = null;
    for (const ev of cal.events) {
      if (new Date(ev.start).getTime() < from.getTime() - DAY_MS) continue;
      if (!trips.isMultiDay(ev)) continue;
      const key = eventKey(ev);
      const { rows: seen } = await db.query(
        `SELECT 1 FROM events
          WHERE user_id = $1 AND event_name = 'travel_pinged' AND metadata->>'event_key' = $2::text
          LIMIT 1`,
        [u.id, key], userLog);
      if (seen.length) continue;
      const trip = await trips.detectTrip(ev, home, userLog);
      if (trip) { pick = { ...trip, key, ev }; break; }
    }
    if (!pick) continue;
    result.found += 1;

    const inWindow = await templates.inWindow(u.id, userLog);
    if (!config.templates.travel_ping && !inWindow) { result.skipped += 1; continue; }
    const sent = await templates.send('travel_ping', {
      to: u.phone_number, user: u, inWindow, data: { destination: pick.destination },
    }, userLog);
    if (sent.sent) {
      result.sent += 1;
      // All-day "end" is the day after the last day.
      const endDate = pick.ev.all_day
        ? new Date(new Date(pick.ev.end).getTime() - DAY_MS).toISOString().slice(0, 10)
        : localDate(pick.ev.end, u.active_timezone);
      await events.record('travel_pinged', {
        userId: u.id,
        metadata: {
          event_key: pick.key,
          destination: pick.destination,
          rule: pick.rule,
          start_date: localDate(pick.ev.start, u.active_timezone, pick.ev.all_day),
          end_date: endDate,
          via: sent.via,
        },
      }, userLog);
    }
  }
  log.info('flows.travel_pings_done', result);
  return result;
}

module.exports = {
  MILESTONES, detectMilestone, localDayHour, eventKey, localDate,
  runWeeklyBriefings, runMilestonePings, runTransitPings, runTravelPings,
};
