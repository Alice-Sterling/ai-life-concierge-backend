/**
 * The voice-note feedback loop (Project 4).
 *
 * Founders do not fill in surveys. Fourteen days after a client becomes
 * Active, Alice asks once for a voice note: what is working, what onboarding
 * felt like, which automations they value. The voice note is transcribed like
 * any other (src/integrations/transcription.js); if it arrives within a week
 * of the request it is also stored as feedback and the team is told.
 *
 *   runRequests()    the lifecycle job: send the day-14 request, once
 *   maybeCapture()   called for every message: is this the answer?
 *
 * The request is a message Alice sends first, so outside the 24-hour window
 * it needs an approved WhatsApp template (TWILIO_TPL_FEEDBACK_REQUEST).
 * Behind FEEDBACK_REQUEST_ENABLED (off by default). Columns: migration 009.
 */

const db = require('../db/pool');
const templates = require('./templates');
const tasks = require('./tasks');
const events = require('./events');
const messages = require('./messages');
const email = require('../integrations/email');
const { config } = require('../config');
const { logger } = require('../lib/logger');

/** The request is only sent in this many days after it first falls due. */
const REQUEST_WINDOW_DAYS = 7;
const MAX_FEEDBACK_CHARS = 8000;

/** What Alice is told when a voice note is the answer to her request. */
const CONTEXT_NOTE =
  'This voice note is the client\'s answer to your request for feedback about the service. It has been '
  + 'saved for the team. Thank them warmly and specifically in one or two sentences. Do not defend, explain '
  + 'or promise changes, do not propose anything, and do not hand over. If they also asked for something, help with that as usual.';

/**
 * Send the day-14 request to everyone it is due for.
 * @param {object} [opts] userId: this client only; ignoreWait: do not wait 14 days (admin test tool)
 */
async function runRequests(log = logger, { userId = null, ignoreWait = false } = {}) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT u.*
         FROM users u
        WHERE u.onboarding_phase = 'Active'
          AND COALESCE(u.conversation_mode, 'ai') = 'ai'
          AND u.feedback_requested_at IS NULL
          AND u.activated_at IS NOT NULL
          AND ($3::boolean OR (
                u.activated_at <= NOW() - make_interval(days => $1::int)
            AND u.activated_at >  NOW() - make_interval(days => $1::int + $4::int)))
          AND ($2::uuid IS NULL OR u.id = $2::uuid)
        LIMIT 100`,
      [config.feedback.afterDays, userId, Boolean(ignoreWait), REQUEST_WINDOW_DAYS], log));
  } catch (err) {
    // Before migration 009 the column is missing: nothing to do yet.
    log.warn('feedback.requests_unavailable', { message: err.message, code: err.code });
    return { due: 0, sent: 0, skipped: 0 };
  }

  const result = { due: rows.length, sent: 0, skipped: 0 };
  for (const u of rows) {
    const userLog = log.child({ user_id: u.id });
    // "Wrote in the last 24 hours" from the message log (voice notes, front-door
    // messages and desk chats are all in it), falling back to the exchange history.
    const inWindow = await messages.inWindow(u.id, userLog);
    if (!config.templates.feedback_request && !inWindow) { result.skipped += 1; continue; }

    const sent = await templates.send('feedback_request', {
      to: u.phone_number, user: u, inWindow, periodKey: 'once',
    }, userLog);
    if (sent.sent && sent.via !== 'inline') {
      await db.query('UPDATE users SET feedback_requested_at = NOW() WHERE id = $1', [u.id], userLog);
      await events.record('feedback_requested', { userId: u.id, metadata: { via: sent.via } }, userLog);
      result.sent += 1;
    } else {
      result.skipped += 1;
    }
  }
  if (rows.length) log.info('feedback.requests_done', result);
  return result;
}

/** The transcript without the "[AUDIO TRANSCRIPT]" marker (and without a typed caption before it). */
function transcriptOf(text) {
  const raw = String(text || '');
  const at = raw.indexOf(messages.AUDIO_PREFIX);
  return at < 0 ? null : raw.slice(at + messages.AUDIO_PREFIX.length).trim() || null;
}

async function tellTeam(user, feedbackRow, content, requestId, log) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';

  // On the Airtable board, as a task nobody has to act on.
  await tasks.create({
    userId: user.id,
    sourceMessage: null,
    aiSummary: `FEEDBACK (voice note) from ${name}:\n${content.slice(0, 1800)}`,
    category: 'general',
    priority: 'normal',
    requiresHuman: false,
    requestId,
  }, log);

  if (email.isConfigured()) {
    try {
      await email.send({
        to: config.admin.alertEmail,
        subject: `CLIENT FEEDBACK: ${name}`,
        text: `${name} answered the feedback request with a voice note.\n\n`
          + `Phone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}\n\n`
          + `Transcript:\n${content}\n\nFeedback ID: ${feedbackRow.id}\nRequest ID: ${requestId || ''}`,
      }, log);
    } catch (err) {
      log.warn('feedback.email_failed', { message: err.message });
    }
  }
  if (config.admin.slackWebhookUrl) {
    try {
      await fetch(config.admin.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The name only: the transcript goes to the desk inbox and the feedback table.
        body: JSON.stringify({ text: `:speech_balloon: *${name}* left voice feedback. The transcript is in the desk inbox.` }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      log.warn('feedback.slack_failed', { message: err.message });
    }
  }
}

/**
 * Is this message the client's answer to the feedback request?
 * Yes when it is a transcribed voice note, the request went out in the last
 * FEEDBACK_LISTEN_DAYS, and no feedback has been stored since the request.
 *
 * @returns {Promise<null|{contextNote: string, feedback_id: string}>}
 */
async function maybeCapture(user, incomingText, { requestId = null } = {}, log = logger) {
  const content = transcriptOf(incomingText);
  if (!content || !user?.id) return null;
  try {
    // The insert itself decides: it writes a row only if the request is recent
    // and nothing was captured since, so two voice notes cannot both count.
    const { rows } = await db.query(
      `INSERT INTO client_feedback (user_id, source, content, metadata)
       SELECT u.id, 'voice_note', $2, $3::jsonb
         FROM users u
        WHERE u.id = $1
          AND u.feedback_requested_at IS NOT NULL
          AND u.feedback_requested_at > NOW() - make_interval(days => $4::int)
          AND NOT EXISTS (SELECT 1 FROM client_feedback f
                           WHERE f.user_id = u.id AND f.created_at >= u.feedback_requested_at)
       RETURNING id`,
      [user.id, content.slice(0, MAX_FEEDBACK_CHARS), JSON.stringify({ request_id: requestId }), config.feedback.listenDays], log);
    if (!rows[0]) return null;

    await events.record('feedback_received', { userId: user.id, requestId, metadata: { feedback_id: rows[0].id, chars: content.length } }, log);
    await tellTeam(user, rows[0], content.slice(0, MAX_FEEDBACK_CHARS), requestId, log);
    log.info('feedback.captured', { user_id: user.id, feedback_id: rows[0].id, chars: content.length });
    return { contextNote: CONTEXT_NOTE, feedback_id: rows[0].id };
  } catch (err) {
    // Never fail a client's message over feedback bookkeeping (or a missing table before 009).
    log.warn('feedback.capture_failed', { message: err.message, code: err.code });
    return null;
  }
}

/** Recent feedback, newest first. Read by GET /admin/feedback. */
async function list({ limit = 50, userId = null } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT f.id, f.user_id, u.first_name, u.last_name, f.source, f.content, f.created_at
       FROM client_feedback f JOIN users u ON u.id = f.user_id
      WHERE ($2::uuid IS NULL OR f.user_id = $2::uuid)
      ORDER BY f.created_at DESC LIMIT $1`, [capped, userId], log);
  return rows;
}

module.exports = { CONTEXT_NOTE, REQUEST_WINDOW_DAYS, runRequests, transcriptOf, maybeCapture, list };
