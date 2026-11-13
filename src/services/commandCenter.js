/**
 * What the Command Center (Project 4) needs beyond plain table reads:
 *
 *   context()            the right-hand panel: status, cohort, trial, calendar
 *                        health, lifestyle preferences, the three latest tasks
 *   sendHumanMessage()   a message typed by a person on the desk
 *
 * The routes in src/routes/admin.js stay thin and call these.
 */

const db = require('../db/pool');
const users = require('./users');
const messages = require('./messages');
const promptContext = require('./promptContext');
const twilio = require('../integrations/twilio');
const { logger } = require('../lib/logger');

/** Twilio's limit for one message body. */
const MAX_MESSAGE_CHARS = 1600;

/** The same text to the same client inside this window is a double click, not a second message. */
const DOUBLE_SEND_MS = 10_000;
const recentSends = new Map();

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });

/**
 * The desk's links from a task summary. A hand-off appends
 * "Booking link: ...", "Vendor phone: ...", "Price: ..." lines (and Alice
 * often writes the same in the brief); these come back as fields the panel
 * can render as a button, a tel: link and a label.
 */
function taskLinks(summary) {
  const text = String(summary || '');
  const line = (label) => new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() || null;
  const anyUrl = /https?:\/\/[^\s)>\]]+/i.exec(text)?.[0] || null;
  const bookingRaw = line('Booking link');
  const booking = bookingRaw ? (/https?:\/\/[^\s)>\]]+/i.exec(bookingRaw)?.[0] || null) : anyUrl;
  const phoneRaw = line('Vendor phone');
  const phone = phoneRaw && /\d{6,}/.test(phoneRaw.replace(/[^\d]/g, '')) ? phoneRaw : null;
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(line('Contact email') || '')?.[0] || null;
  return {
    booking_url: booking,
    phone_number: phone,
    tel_link: phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null,
    contact_email: email,
    formatted_address: line('Address'),
    price: line('Price'),
  };
}

/**
 * The webhook raises one task per message a client sends while in human mode,
 * so the desk sees the text in Airtable. In the panel those are echoes of the
 * chat, not work items, and would push every real task out of the top three.
 */
const QUEUED_ECHO = 'Queued while the user is in human conversation mode.';

/** The three most recent tasks of a client, newest first, with their desk links. */
async function recentTasks(userId, { limit = 3 } = {}, log = logger) {
  const { rows } = await db.query(
    `SELECT task_id, status, priority, category, ai_summary, source_message,
            airtable_record_id, created_at, updated_at, completed_at
       FROM tasks
      WHERE user_id = $1 AND ai_summary IS DISTINCT FROM $3
      ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 3, 1), 20), QUEUED_ECHO], log);
  return rows.map((t) => ({ ...t, links: taskLinks(t.ai_summary) }));
}

/** "Active | Cohort 1 | Trial Expires in 42 Days", from what is known. */
function headline(extra, trial) {
  const parts = [extra?.account_status || 'Unknown'];
  if (extra?.cohort_id) parts.push(extra.cohort_id);
  if (trial) {
    parts.push(trial.trial_days_left >= 0
      ? `Trial expires in ${trial.trial_days_left} day${trial.trial_days_left === 1 ? '' : 's'}`
      : `Trial ended ${-trial.trial_days_left} day${trial.trial_days_left === -1 ? '' : 's'} ago`);
  }
  return parts.join(' | ');
}

/**
 * Everything the context panel shows for one client.
 * @returns {Promise<object|null>} null when the user does not exist
 */
async function context(userId, log = logger) {
  const user = await users.findById(userId, log);
  if (!user) return null;

  const extra = (await users.commandCenterFields([userId], log))[userId] || {};
  const trial = users.trialWindow(extra);

  // preferences and active_automations are not in PUBLIC_COLUMNS.
  const { rows } = await db.query(
    'SELECT preferences, active_automations, calendar_connected FROM users WHERE id = $1', [userId], log);
  const profileRow = rows[0] || {};

  return {
    user: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      phone_number: user.phone_number,
      email: user.email,
      client_id: user.short_id || user.client_id,
      active_timezone: user.active_timezone,
    },
    headline: headline(extra, trial),
    status: {
      account_status: extra.account_status ?? null,
      onboarding_phase: user.onboarding_phase,
      cohort_id: extra.cohort_id ?? null,
      trial_duration_days: extra.trial_duration_days ?? null,
      ...(trial || { trial_started_at: null, trial_ends_at: null, trial_days_left: null }),
    },
    conversation: {
      mode: user.conversation_mode,
      human_override_until: extra.human_override_until ?? null,
      mode_changed_at: user.conversation_mode_changed_at,
    },
    calendar: {
      connected: profileRow.calendar_connected === true,
      provider: extra.calendar_provider ?? null,
      token_status: extra.calendar_token_status ?? null,
      token_last_refreshed_at: extra.calendar_token_last_refreshed_at ?? null,
      disconnected_at: extra.calendar_disconnected_at ?? null,
    },
    lifestyle_preferences: promptContext.profileFacts({
      preferences: profileRow.preferences, active_automations: profileRow.active_automations,
    }),
    recent_tasks: await recentTasks(userId, { limit: 3 }, log),
  };
}

/**
 * A person on the desk sends a WhatsApp message to a client.
 *
 * Sending is taking over: the client goes to human mode (or, if already
 * there, the human window starts again), the message is logged as
 * 'human_agent' and it goes out through Twilio.
 *
 * WhatsApp only delivers free text inside 24 hours of the client's last
 * message. Outside that it is refused here, loudly, instead of looking sent.
 *
 * @throws {Error} with .status and .code for the route to return
 */
async function sendHumanMessage({ userId, content, actor = 'admin', requestId = null }, log = logger) {
  const text = String(content ?? '').trim();
  if (!text) throw fail(400, 'empty_message', 'content is required');
  if (text.length > MAX_MESSAGE_CHARS) {
    throw fail(400, 'message_too_long', `content is ${text.length} characters; the limit is ${MAX_MESSAGE_CHARS}`);
  }

  const user = await users.findById(userId, log);
  if (!user) throw fail(404, 'user_not_found', 'User not found');
  if (!user.phone_number) throw fail(409, 'no_phone_number', 'This client has no phone number');
  if (!twilio.isConfigured()) throw fail(503, 'twilio_not_configured', 'Twilio is not configured, so nothing can be sent');

  if (!(await messages.inWindow(userId, log))) {
    throw fail(409, 'outside_24h_window',
      'The client has not written in the last 24 hours. WhatsApp only delivers an approved template now, not free text.');
  }

  const key = `${userId}:${text}`;
  const last = recentSends.get(key) || 0;
  if (Date.now() - last < DOUBLE_SEND_MS) {
    throw fail(409, 'duplicate_send', 'The same message was sent to this client a moment ago');
  }
  recentSends.set(key, Date.now());
  if (recentSends.size > 500) recentSends.clear();

  // Take over first: if the mode switch failed after the send, Alice could
  // answer the client's reply over the top of the person who just wrote.
  let humanOverrideUntil;
  if (user.conversation_mode !== 'human') {
    const updated = await users.setConversationMode(userId, 'human', { requestId, source: `admin:${actor}` }, log);
    humanOverrideUntil = updated?.human_override_until ?? null;
  } else {
    humanOverrideUntil = await users.extendHumanOverride(userId, log);
  }

  const ok = await twilio.sendWhatsApp(user.phone_number, text, log, {
    userId, senderType: 'human_agent', actor, requestId,
  });
  if (!ok) {
    recentSends.delete(key);
    await messages.system(userId, `A message from ${actor} was not delivered: Twilio refused it.`,
      { event: 'send_failed', actor }, log);
    throw fail(502, 'twilio_send_failed', 'Twilio refused the message. See the Twilio error log.');
  }

  log.info('command_center.message_sent', { user_id: userId, actor, chars: text.length });
  return {
    user_id: userId,
    conversation_mode: 'human',
    human_override_until: humanOverrideUntil,
    content: text,
    sender_type: 'human_agent',
  };
}

module.exports = {
  MAX_MESSAGE_CHARS, taskLinks, recentTasks, headline, context, sendHumanMessage,
  _resetSends: () => recentSends.clear(),
};
