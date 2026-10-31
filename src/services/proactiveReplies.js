/**
 * Answers to Alice's proactive pings (the template quick-reply buttons).
 *
 *   date-night ping  [ Review Options ] -> short "one moment", then Alice curates
 *                    [ Skip This Week ] -> rescheduled, Alice not called
 *   handshake ping   [ Ready ]          -> Alice writes the week-ahead briefing
 *   weekly briefing  [ Yes, Please ]    -> canned "tell me who, where, what" (brief's wording)
 *                    [ All Handled ]    -> canned sign-off, Alice not called
 *   milestone ping   [ Yes, please ]    -> short "one moment", then Alice proposes 2-3 concepts
 *                    [ Pass this time ] -> canned reply, Alice not called
 *   transit ping     [ Uber ]           -> Alice proposes a pickup time and sends the Uber link
 *                    [ Rail ]           -> Alice takes the details and hands rail to the desk
 *                    [ All Handled ]    -> canned reply, Alice not called
 *
 * "Yes" is a common word, so for the two newer pings it only counts as a
 * button answer if nothing else was said since the ping.
 *
 * A word only counts as a button answer shortly after the ping that offered
 * it, so "skip the starter" in an ordinary chat is never read as "skip date night".
 *
 * Returns either a finished reply (Alice is not called) or a context note
 * that runAgenticConcierge adds to her system prompt for this one turn.
 */

const db = require('../db/pool');
const twilio = require('../integrations/twilio');
const events = require('./events');
const templates = require('./templates');
const { logger } = require('../lib/logger');

const PING_ANSWER_HOURS = 48;

const SKIP = /^\s*skip\b/i;
const REVIEW = /^\s*review\b/i;
const READY = /^\s*ready\b/i;
const YES = /^\s*yes\b/i;
const ALL_HANDLED = /^\s*all\s+handled\b/i;
const PASS = /^\s*pass\b/i;
const UBER = /^\s*uber\b/i;
const RAIL = /^\s*rail\b/i;

const REVIEW_ACK = 'Wonderful. Give me just a moment to cross-reference your calendar with live availability...';

// Flow 2 and 3 wording from the brief.
const WEEKLY_YES_REPLY = "Wonderful. Tell me who you're meeting, where, and what kind of atmosphere or logistics you need.";
const WEEKLY_HANDLED_REPLY = "Understood. I'm right here if anything pops up mid-week. Have a brilliant week.";
const MILESTONE_PASS_REPLY = "Understood, I'll leave this one. If you change your mind, just message me here.";
const milestoneAck = (type) =>
  `Wonderful. Give me just a moment to cross-reference our boutique partners and check live availability for ${type} concepts...`;

function milestoneNote(type, date) {
  return `The client just tapped "Yes, please" on Alice's ping about a ${type}`
    + `${date ? ` on ${date}` : ''}, about three weeks away. Propose 2-3 specific concepts for it `
    + '(a celebration dinner, florals delivered on the day, an experience, or a gift and card) that fit '
    + 'their preferences and city. Verify before you pitch. You may ask one short question if you truly '
    + `need it (for example whose ${type} it is). When they choose, follow the execution and hand-off protocol.`;
}

const TRANSIT_HANDLED_REPLY = "Understood. Have a wonderful trip, and I'm right here if anything changes.";

/** One line about the flight from the stored ping, in the client's timezone. */
function flightLine(meta = {}, tz) {
  let when = null;
  if (meta.departs) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(meta.departs);
    try {
      when = new Date(meta.departs).toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
        ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
        timeZone: dateOnly ? 'UTC' : (tz || 'Europe/London'),
      });
    } catch {
      when = String(meta.departs);
    }
  }
  return [
    meta.flight ? `flight ${meta.flight}` : 'a flight',
    meta.destination ? `to ${meta.destination}` : null,
    meta.from_airport ? `from ${meta.from_airport}` : null,
    when ? `departing ${when}` : null,
  ].filter(Boolean).join(' ');
}

function transitUberNote(meta, tz) {
  return `The client just tapped "Uber" on Alice's ping about their ${flightLine(meta, tz)} (from their calendar). `
    + 'Arrange the ride to the departure airport: propose a pickup time (about 3 hours before an international '
    + 'departure, 2 hours before a domestic one) and ask only for what you do not know yet (normally the pickup '
    + 'address). Then call request_transit with the pickup address and the departure airport and terminal as '
    + 'the drop-off, send the link, remind them to tap "Schedule" in Uber for that time, and offer that the '
    + 'team can book it for them instead.';
}

function transitRailNote(meta, tz) {
  return `The client just tapped "Rail" on Alice's ping about their ${flightLine(meta, tz)} (from their calendar). `
    + 'Rail tickets are booked by the concierge team. Confirm in one short message the station or address they '
    + 'travel from and when they want to arrive at the airport (suggest a time), then call handoff_to_concierge '
    + 'with the full journey details.';
}

/**
 * The newest of these pings sent to the client in the last `hours`, if the
 * client has not said anything since it went out.
 */
async function openPing(userId, keys, hours, log) {
  const { rows } = await db.query(
    `SELECT o.template_key, o.created_at
       FROM outbound_messages o
      WHERE o.user_id = $1 AND o.template_key = ANY($2::text[])
        AND o.created_at > NOW() - make_interval(hours => $3::int)
        AND NOT EXISTS (SELECT 1 FROM conversations c
                         WHERE c.user_id = o.user_id AND c.timestamp > o.created_at)
      ORDER BY o.created_at DESC LIMIT 1`,
    [userId, keys, hours], log);
  return rows[0]?.template_key || null;
}

function dateNightNote(user) {
  return `The client just tapped "Review Options" on their ${templates.cadenceWord(user)} date-night ping. `
    + 'Check their calendar for 2-3 free evenings (18:00-22:00, their local time) in the next two weeks. '
    + `Then present exactly 2 contrasting, specific date-night options for them and ${templates.partnerName(user)}, `
    + 'each matched to one of those free evenings with an exact time. Use the preferences you already have; '
    + 'do not ask for them again. When they choose, follow the execution and hand-off protocol.';
}

const HANDSHAKE_NOTE =
  'The client just tapped "Ready" on the post-activation handshake. Look at their calendar for the next '
  + '30 days and reference one or two specific upcoming events. Write a warm, concise briefing for their '
  + 'week ahead that invites them to review or switch on their chosen automations (for example a regular '
  + 'date-night cadence). Do not sound robotic and do not list every feature.';

function formatDate(date, tz) {
  try {
    return new Date(date).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: tz || 'Europe/London',
    });
  } catch {
    return new Date(date).toDateString();
  }
}

/**
 * @returns {Promise<{reply?: string, contextNote?: string}>} empty when the
 *   message is not an answer to a ping
 */
async function handle(user, incomingText, { requestId = null } = {}, log = logger) {
  const text = String(incomingText || '');
  if (!user?.id || text.length > 60) return {};

  if ((SKIP.test(text) || REVIEW.test(text))
      && await templates.sentRecently(user.id, 'datenight_ping', log, PING_ANSWER_HOURS)) {
    if (SKIP.test(text)) {
      const { rows } = await db.query(
        `UPDATE users
            SET next_date_due_at = NOW() + make_interval(days => COALESCE(date_night_cadence, 14)::int)
          WHERE id = $1
          RETURNING next_date_due_at, active_timezone`,
        [user.id], log);
      await events.record('date_night_skipped', { userId: user.id, requestId }, log);
      const next = rows[0] ? formatDate(rows[0].next_date_due_at, rows[0].active_timezone) : null;
      return {
        reply: `No problem, I'll skip this one.${next ? ` Your next date night curation is planned for ${next}.` : ''} `
          + "If anything comes up before then, I'm right here.",
      };
    }

    // The "one moment" goes out on its own so it arrives before Alice's answer.
    // Inline mode cannot send two messages in one reply, so there it is dropped.
    if (twilio.isConfigured()) await twilio.sendWhatsApp(user.phone_number, REVIEW_ACK, log);
    await events.record('date_night_review_requested', { userId: user.id, requestId }, log);
    return { contextNote: dateNightNote(user) };
  }

  if (READY.test(text)
      && await templates.sentRecently(user.id, 'handshake_ping', log, PING_ANSWER_HOURS + 24)) {
    await events.record('post_activation_handshake_completed', { userId: user.id, requestId }, log);
    return { contextNote: HANDSHAKE_NOTE };
  }

  if (YES.test(text) || ALL_HANDLED.test(text) || PASS.test(text) || UBER.test(text) || RAIL.test(text)) {
    const ping = await openPing(user.id, ['weekly_briefing', 'milestone_ping', 'transit_ping'], PING_ANSWER_HOURS, log);

    if (ping === 'transit_ping' && (UBER.test(text) || RAIL.test(text) || ALL_HANDLED.test(text))) {
      if (ALL_HANDLED.test(text)) {
        await events.record('transit_all_handled', { userId: user.id, requestId }, log);
        return { reply: TRANSIT_HANDLED_REPLY };
      }
      const { rows } = await db.query(
        `SELECT metadata FROM events
          WHERE user_id = $1 AND event_name = 'transit_pinged'
          ORDER BY timestamp DESC LIMIT 1`,
        [user.id], log);
      const meta = rows[0]?.metadata || {};
      const rail = RAIL.test(text);
      await events.record(rail ? 'transit_rail_requested' : 'transit_uber_requested', {
        userId: user.id, requestId, metadata: { flight: meta.flight || null },
      }, log);
      return { contextNote: rail ? transitRailNote(meta, user.active_timezone) : transitUberNote(meta, user.active_timezone) };
    }

    if (ping === 'weekly_briefing' && (YES.test(text) || ALL_HANDLED.test(text))) {
      const yes = YES.test(text);
      await events.record(yes ? 'weekly_briefing_yes' : 'weekly_briefing_all_handled', { userId: user.id, requestId }, log);
      return { reply: yes ? WEEKLY_YES_REPLY : WEEKLY_HANDLED_REPLY };
    }

    if (ping === 'milestone_ping' && (YES.test(text) || PASS.test(text))) {
      const { rows } = await db.query(
        `SELECT metadata FROM events
          WHERE user_id = $1 AND event_name = 'milestone_pinged'
          ORDER BY timestamp DESC LIMIT 1`,
        [user.id], log);
      const type = rows[0]?.metadata?.event_type || 'special occasion';
      const date = rows[0]?.metadata?.event_date
        ? formatDate(rows[0].metadata.event_date, user.active_timezone) : null;

      if (PASS.test(text)) {
        await events.record('milestone_passed', { userId: user.id, requestId, metadata: { event_type: type } }, log);
        return { reply: MILESTONE_PASS_REPLY };
      }
      if (twilio.isConfigured()) await twilio.sendWhatsApp(user.phone_number, milestoneAck(type), log);
      await events.record('milestone_accepted', { userId: user.id, requestId, metadata: { event_type: type } }, log);
      return { contextNote: milestoneNote(type, date) };
    }
  }

  return {};
}

module.exports = {
  REVIEW_ACK, HANDSHAKE_NOTE, WEEKLY_YES_REPLY, WEEKLY_HANDLED_REPLY, MILESTONE_PASS_REPLY, TRANSIT_HANDLED_REPLY,
  dateNightNote, milestoneNote, flightLine, transitUberNote, transitRailNote, handle,
};
