/**
 * Answers to Alice's proactive pings (the template quick-reply buttons).
 *
 *   date-night ping  [ Review Options ] -> short "one moment", then Alice curates
 *                    [ Skip This Week ] -> rescheduled, Alice not called
 *   handshake ping   [ Ready ]          -> Alice writes the week-ahead briefing
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

const REVIEW_ACK = 'Wonderful. Give me just a moment to cross-reference your calendar with live availability...';

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

  return {};
}

module.exports = { REVIEW_ACK, HANDSHAKE_NOTE, dateNightNote, handle };
