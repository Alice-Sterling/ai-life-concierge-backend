/**
 * The front door (Project 3, Step A).
 *
 * Runs on every inbound WhatsApp message, before Alice. Decides from the
 * client's status whether Alice answers, or whether they get a fixed status
 * message and nothing else:
 *
 *   unknown number -> "access is by invitation, join the waitlist"
 *   Waitlist       -> "you're on the waitlist"
 *   Denied         -> "we can't offer you membership"
 *   Approved       -> "your invitation is ready" + onboarding link
 *   Onboarded      -> "one final step" + payment link
 *   Inactive       -> "membership inactive"; replying HELP raises a desk task
 *   Active         -> Alice. The welcome goes out once, first.
 *
 * Airtable is where the ops team changes a status, so the status is re-read
 * from Airtable on every message and copied into Postgres when it differs.
 * Without that, a client approved in Airtable would keep hearing "you're on
 * the waitlist" until something else happened to sync them.
 *
 * Behind STATUS_GATE_ENABLED. With it off, the webhook behaves exactly as before.
 */

const db = require('../db/pool');
const airtable = require('../integrations/airtable');
const twilio = require('../integrations/twilio');
const email = require('../integrations/email');
const users = require('./users');
const tasks = require('./tasks');
const events = require('./events');
const conversations = require('./conversations');
const templates = require('./templates');
const { logger } = require('../lib/logger');

const DESK_EMAIL = 'assist@ailifeconcierge.co.uk';

/** Which template each non-Active status gets. */
const STATUS_TEMPLATE = {
  Waitlist: 'status_waitlist',
  Denied: 'status_denied',
  Approved: 'status_approved',
  Onboarded: 'pending_stripe',
  Inactive: 'membership_inactive',
};

/**
 * A bare hello. When the welcome is sent in reply to one of these, the welcome
 * IS the answer and Alice stays out of it. Anything with substance goes on to
 * Alice as well, so a first message like "book me dinner Friday" is not lost.
 */
const GREETING = /^\s*(hi|hiya|hello|hey|yo|ready|start|good (morning|afternoon|evening))\b[\s!.?,]*(alice)?[\s!.?]*$/i;

/** The Inactive template's quick reply, or a typed HELP. */
const HELP_REQUEST = /\bhelp\b/i;

const MEMBERSHIP_HELP_ACK = 'Thank you. Our team will be in touch with you here shortly.';

const cleanPhone = (p) => String(p || '').replace(/^whatsapp:/i, '').trim();

async function lookupAirtable({ clientId, phone }, log) {
  try {
    return await airtable.findUserRecord({ clientId, phone }, log);
  } catch (err) {
    // Airtable down must not block the WhatsApp line: fall back to Postgres.
    log.warn('gate.airtable_lookup_failed', { message: err.message });
    return null;
  }
}

/** Send a short free-text reply, or hand it back for TwiML if Twilio cannot. */
async function replyText(to, text, log) {
  if (!twilio.isConfigured()) return { text, via: 'inline' };
  await twilio.sendWhatsApp(to, text, log);
  return { text, via: 'text' };
}

/**
 * A number with no Postgres row. If Airtable knows them (they signed up on
 * the website), create their row from it and let them through to admit().
 *
 * @returns {Promise<object|null>} the new user row, or null if nobody knows them
 */
async function adoptFromAirtable(phoneNumber, profileName, log = logger) {
  const record = await lookupAirtable({ phone: cleanPhone(phoneNumber) }, log);
  if (!record) return null;

  const f = record.fields || {};
  const pick = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const phase = users.normalizePhase(f.Status) || 'Waitlist';

  // client_id is UNIQUE. If Airtable's id is already taken by another row,
  // leave it null and let the webhook mint one, rather than fail the message.
  const insert = (clientId) => db.query(
    `INSERT INTO users (phone_number, first_name, last_name, email, tier, client_id, onboarding_phase)
     VALUES ($1, $2, $3, $4, 'lite', $5, $6)
     RETURNING *`,
    [phoneNumber, pick(f['First Name']) || profileName || 'Explorer', pick(f['Last Name']),
      pick(f.Email), clientId, phase],
    log);

  let rows;
  try {
    ({ rows } = await insert(pick(f['Client ID'])));
  } catch (err) {
    if (err.code !== '23505') throw err;
    ({ rows } = await insert(null));
  }

  log.info('gate.user_adopted_from_airtable', { user_id: rows[0].id, onboarding_phase: phase });
  return rows[0];
}

/**
 * Reply to a number nobody knows. Rate-limited per number, so someone
 * writing five times gets one invitation, not five.
 *
 * @returns {Promise<{text: string, via: string}|null>} null when suppressed
 */
async function rejectUnknown(phoneNumber, { requestId = null } = {}, log = logger) {
  const phone = cleanPhone(phoneNumber);
  const { rows } = await db.query(
    `SELECT 1 FROM events
      WHERE event_name = 'unrecognized_contact' AND metadata->>'phone' = $1
        AND timestamp > NOW() - make_interval(hours => $2::int)
      LIMIT 1`,
    [phone, templates.REPEAT_WINDOW_HOURS], log);

  await events.record('unrecognized_contact', {
    requestId, metadata: { phone, suppressed: rows.length > 0 },
  }, log);
  if (rows.length > 0) return null;

  const sent = await templates.send('unrecognized_user', { to: phoneNumber, requestId }, log);
  return { text: sent.text, via: sent.via };
}

/** Copy a status changed in Airtable into Postgres. Returns the effective status. */
async function syncStatus(user, phoneNumber, requestId, log) {
  const record = await lookupAirtable({
    clientId: user.client_id || user.short_id,
    phone: cleanPhone(phoneNumber || user.phone_number),
  }, log);
  const fromAirtable = users.normalizePhase(record?.fields?.Status);

  if (fromAirtable && fromAirtable !== user.onboarding_phase) {
    await users.setOnboardingPhase(user.id, fromAirtable, { requestId, fromAirtable: true }, log);
    log.info('gate.status_synced_from_airtable', { from: user.onboarding_phase, to: fromAirtable });
    user.onboarding_phase = fromAirtable;
  }
  return user.onboarding_phase || 'Waitlist';
}

/**
 * Decide what happens to a known user's message.
 *
 * @returns {Promise<{halt: true, reply: {text: string, via: string}|null}
 *                  | {halt: false, user: object}>}
 *   halt: Alice must not run. `reply` is null when the reply was suppressed;
 *   via 'inline' means the caller puts reply.text in the TwiML response.
 */
async function admit(user, { phoneNumber, incomingText = '', requestId = null } = {}, log = logger) {
  const to = phoneNumber || user.phone_number;
  const status = await syncStatus(user, to, requestId, log);

  if (status === 'Active') {
    // Web onboarding replaces the old 8-step WhatsApp interview. Without
    // this, Alice would start asking an Active member for their email.
    if (user.onboarding_status === 'pending') {
      await db.query(
        `UPDATE users SET onboarding_status = 'complete', onboarding_step = GREATEST(onboarding_step, 8)
          WHERE id = $1 AND onboarding_status = 'pending'`,
        [user.id], log);
      user.onboarding_status = 'complete';
      user.onboarding_step = Math.max(Number(user.onboarding_step) || 1, 8);
    }

    if (!user.welcome_message_sent && await users.claimWelcome(user.id, log)) {
      user.welcome_message_sent = true;
      const sent = await templates.send('active_welcome', { to, user, requestId }, log);
      if (GREETING.test(incomingText)) {
        await conversations.save(user.id, incomingText, sent.text, { gate: 'active_welcome' }, log);
        return { halt: true, reply: { text: sent.text, via: sent.via } };
      }
      // A real request: the welcome has gone, and Alice answers it next.
      // Inline mode cannot send two messages in one TwiML reply, so there the
      // welcome is dropped in favour of the answer.
    }
    return { halt: false, user };
  }

  if (status === 'Inactive' && HELP_REQUEST.test(incomingText)) {
    await tasks.create({
      userId: user.id,
      sourceMessage: incomingText,
      aiSummary: `Inactive member asked for help with their membership. `
        + `${user.first_name || ''} ${user.last_name || ''} (${user.phone_number || ''}).`,
      category: 'general',
      priority: 'high',
      requiresHuman: true,
      assignedTo: DESK_EMAIL,
      requestId,
    }, log);
    if (email.isConfigured()) {
      await email.send({
        to: DESK_EMAIL,
        subject: `MEMBERSHIP HELP: ${user.first_name || user.phone_number}`,
        text: `An inactive member asked for help.\n\nName: ${user.first_name || ''} ${user.last_name || ''}\n`
          + `Phone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}\n`
          + `Message: ${incomingText}\nRequest ID: ${requestId || ''}`,
      }, log);
    }
    const reply = await replyText(to, MEMBERSHIP_HELP_ACK, log);
    await conversations.save(user.id, incomingText, reply.text, { gate: 'membership_help' }, log);
    return { halt: true, reply };
  }

  const key = STATUS_TEMPLATE[status] || 'status_waitlist';

  if (await templates.sentRecently(user.id, key, log)) {
    await conversations.save(user.id, incomingText, null, { gate: key, suppressed: true }, log);
    log.info('gate.template_suppressed', { template: key });
    return { halt: true, reply: null };
  }

  const sent = await templates.send(key, { to, user, requestId }, log);
  await conversations.save(user.id, incomingText, sent.text, { gate: key }, log);
  return { halt: true, reply: { text: sent.text, via: sent.via } };
}

module.exports = { STATUS_TEMPLATE, GREETING, adoptFromAirtable, rejectUnknown, admit };
