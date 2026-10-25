/**
 * Lifecycle messages (Project 3): the moments Alice writes first.
 *
 *   activate()               Stripe checkout or Airtable -> status Active, welcome once
 *   onStatusChange()         Airtable status changed -> the matching template
 *   runOnboardingReminders() Approved but not onboarded 24h after the invite
 *   runHandshakePings()      48h after activation, if the client has gone quiet
 *   runProposalNudges()      options sent 4h ago and no answer
 *
 * Every send goes through templates.send(), so it is recorded in
 * outbound_messages with its template_key. That record is how each job knows
 * it already sent something: nothing here keeps state of its own.
 *
 * Outside Meta's 24-hour window only an approved template can be delivered,
 * so a job whose template has no SID yet skips quietly rather than "sending"
 * text that Meta would drop.
 */

const db = require('../db/pool');
const { config } = require('../config');
const users = require('./users');
const events = require('./events');
const templates = require('./templates');
const airtable = require('../integrations/airtable');
const { logger } = require('../lib/logger');

/** What the brief's Airtable triggers send for each status. */
const STATUS_CHANGE_TEMPLATE = {
  Approved: 'status_approved',
  Waitlist: 'status_waitlist',
  Denied: 'status_denied',
};

/** A repeated Airtable edit within this window does not re-send. */
const STATUS_CHANGE_REPEAT_HOURS = 24;

/** The handshake ping only goes to recent activations, never to old members out of the blue. */
const HANDSHAKE_MAX_AGE_DAYS = 7;

/** Two numbered or "Option" lines read as options Alice put to the client. */
const PROPOSAL = /(^|\n)\s*(\*{0,2})(1[.)]|option (1|one|a)\b)[\s\S]*(^|\n)\s*(\*{0,2})(2[.)]|option (2|two|b)\b)/im;

/** Can this template reach this client right now? */
async function canSend(key, userId, log) {
  if (config.templates[key]) return { ok: true, inWindow: await templates.inWindow(userId, log) };
  const inWindow = await templates.inWindow(userId, log);
  return { ok: inWindow, inWindow };
}

async function findUser({ clientId, phone }, log) {
  if (clientId) {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE client_id = $1::varchar OR short_id = $1::varchar LIMIT 1',
      [String(clientId).trim()], log);
    if (rows[0]) return rows[0];
  }
  const variants = airtable.phoneDigitVariants(phone);
  if (variants.length) {
    // Digits only on both sides: "07700 900123" in Airtable is "whatsapp:+447700900123" here.
    const { rows } = await db.query(
      `SELECT * FROM users
        WHERE regexp_replace(phone_number, '[^0-9]', '', 'g') = ANY($1::text[])
        ORDER BY created_at ASC LIMIT 1`,
      [variants], log);
    const user = rows[0];
    if (user && clientId && user.short_id !== clientId) {
      // Found by phone with the website's Client ID in hand: link them for good.
      try {
        await db.query('UPDATE users SET short_id = $2::varchar, client_id = $2::varchar WHERE id = $1',
          [user.id, String(clientId).trim()], log);
        user.short_id = String(clientId).trim();
        user.client_id = user.short_id;
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (user) return user;
  }
  return null;
}

/**
 * The Postgres client for a website Client ID, for callers that only have the
 * Client ID (the n8n calendar login). Website sign-ups often reach the backend
 * here first, before they ever write on WhatsApp, so a miss is not the end:
 *
 *   1. a user with that client_id / short_id
 *   2. the Airtable row with that Client ID -> its phone -> a user with that
 *      phone (digits only). Linked to the website id, unless their current id
 *      belongs to another Airtable row (duplicate rows for one phone: never
 *      flip a link back and forth)
 *   3. no user yet -> created from that Airtable row, like the front door does
 *
 * @returns {Promise<object|null>} null when neither Postgres nor Airtable knows the id
 */
async function findOrAdoptClient(clientId, log = logger) {
  const id = String(clientId || '').trim();
  if (!id) return null;

  const byId = await findUser({ clientId: id }, log);
  if (byId) return byId;

  const record = await airtable.findUserRecord({ clientId: id }, log);
  const phone = record?.fields?.[config.airtable.phoneField];
  const variants = airtable.phoneDigitVariants(phone);
  if (!variants.length) return null;

  const { rows } = await db.query(
    `SELECT * FROM users
      WHERE regexp_replace(phone_number, '[^0-9]', '', 'g') = ANY($1::text[])
      ORDER BY created_at ASC LIMIT 1`,
    [variants], log);
  const user = rows[0];
  if (user) {
    const ownIds = [user.short_id, user.client_id].filter(Boolean);
    const theirRow = ownIds.length ? await airtable.findUserRecord({ clientId: ownIds }, log) : null;
    if (!theirRow) {
      try {
        await db.query('UPDATE users SET short_id = $2::varchar, client_id = $2::varchar WHERE id = $1', [user.id, id], log);
        user.short_id = id;
        user.client_id = id;
        log.info('lifecycle.client_linked', { user_id: user.id, source: 'calendar_connect' });
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    return user;
  }

  const gateway = require('./gateway');
  return gateway.adoptFromAirtable(`whatsapp:+${variants[0]}`, null, log);
}

/**
 * Activation means the trial has started. The legacy membership check
 * (concierge.js evaluateTrialMembershipFromAirtable) only grants Founding
 * Member access when Airtable "Stripe Status" says "Trial Started", and n8n
 * used to write that at form submission, before payment. Writing it here, at
 * the real start, lets that early write go. An existing value (e.g. "Trial
 * Ended") is left alone.
 */
async function markTrialStarted(user, log = logger) {
  if (!airtable.isConfigured()) return false;
  const record = await airtable.findUserRecord({
    clientId: [user.short_id, user.client_id], phone: user.phone_number,
  }, log);
  if (!record) return false;
  const current = [].concat(record.fields?.['Stripe Status'] ?? []).filter(Boolean);
  if (current.length) return false;
  const ok = await airtable.updateUserRecord(record.id, { 'Stripe Status': 'Trial Started' }, log);
  if (ok) log.info('lifecycle.trial_started_marked', { user_id: user.id });
  return ok;
}

/**
 * The client is now Active: status, start time, and the welcome exactly once.
 *
 * If the welcome cannot be delivered (no template yet, client outside the
 * window) the claim is released, so the front door sends it the next time
 * they write instead of it being lost.
 */
async function activate(user, { source, requestId = null } = {}, log = logger) {
  if (user.onboarding_phase !== 'Active') {
    await users.setOnboardingPhase(user.id, 'Active', { requestId, fromAirtable: source === 'airtable' }, log);
  }
  await db.query(
    'UPDATE users SET activated_at = COALESCE(activated_at, NOW()) WHERE id = $1', [user.id], log);
  try {
    await markTrialStarted(user, log);
  } catch (err) {
    // Airtable is a mirror: activation goes ahead without it.
    log.warn('lifecycle.trial_started_mark_failed', { user_id: user.id, message: err.message });
  }

  let welcome = 'already_sent';
  if (await users.claimWelcome(user.id, log)) {
    const reach = await canSend('active_welcome', user.id, log);
    const sent = reach.ok
      ? await templates.send('active_welcome', {
        to: user.phone_number, user, inWindow: reach.inWindow, requestId,
      }, log)
      : { sent: false, via: 'none' };
    if (sent.sent && sent.via !== 'inline') {
      welcome = 'sent';
    } else {
      await db.query('UPDATE users SET welcome_message_sent = false WHERE id = $1', [user.id], log);
      welcome = 'deferred_to_next_message';
    }
  }

  await events.record('activated', { userId: user.id, requestId, metadata: { source, welcome } }, log);
  log.info('lifecycle.activated', { user_id: user.id, source, welcome });
  return { welcome };
}

/**
 * A status changed in Airtable (called by n8n). Copies it to Postgres and
 * sends what the brief asks for that status.
 *
 * @returns {Promise<object|null>} null when nobody has that client id or phone
 */
async function onStatusChange({ clientId = null, phone = null, status }, { requestId = null } = {}, log = logger) {
  const phase = users.normalizePhase(status);
  if (!phase) {
    throw Object.assign(
      new Error(`status must be one of: ${users.ONBOARDING_PHASES.join(', ')}`), { status: 400 });
  }

  let user = await findUser({ clientId, phone }, log);
  if (!user && phone) {
    // Signed up on the website, never wrote on WhatsApp: create them from Airtable.
    const gateway = require('./gateway');
    const bare = String(phone).replace(/^whatsapp:/i, '').trim();
    user = await gateway.adoptFromAirtable(`whatsapp:${bare}`, null, log);
  }
  if (!user) return null;

  const userLog = log.child({ user_id: user.id });
  const result = { user_id: user.id, status: phase, template: null, sent: false, via: 'none' };

  if (phase === 'Active') {
    const { welcome } = await activate(user, { source: 'airtable', requestId }, userLog);
    return { ...result, template: 'active_welcome', sent: welcome === 'sent', via: welcome };
  }

  if (user.onboarding_phase !== phase) {
    await users.setOnboardingPhase(user.id, phase, { requestId, fromAirtable: true }, userLog);
  }

  const key = STATUS_CHANGE_TEMPLATE[phase];
  if (!key) return result;
  result.template = key;

  if (await templates.sentRecently(user.id, key, userLog, STATUS_CHANGE_REPEAT_HOURS)) {
    return { ...result, via: 'suppressed_repeat' };
  }

  const reach = await canSend(key, user.id, userLog);
  if (!reach.ok) return { ...result, via: 'no_template_outside_window' };

  const sent = await templates.send(key, {
    to: user.phone_number, user, inWindow: reach.inWindow, requestId,
  }, userLog);
  await events.record('status_change_notified', {
    userId: user.id, requestId, metadata: { status: phase, template: key, via: sent.via },
  }, userLog);
  return { ...result, sent: sent.sent, via: sent.via };
}

/**
 * Every job below takes the same options, used only by the admin test tool:
 *   userId      run for this one client only
 *   ignoreWait  treat the wait (24h, 48h, 4h) as already over
 */
const waitHours = (hours, { ignoreWait = false } = {}) => (ignoreWait ? 0 : hours);

/**
 * Approved, invited, and still not onboarded a day later: one reminder.
 * "Once" means once per invitation, so a fresh invite earns a fresh reminder.
 */
async function runOnboardingReminders(log = logger, opts = {}) {
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
       JOIN LATERAL (
         SELECT MAX(created_at) AS invited_at FROM outbound_messages
          WHERE user_id = u.id AND template_key = 'status_approved' AND status IN ('sent', 'inline')
       ) inv ON inv.invited_at IS NOT NULL
      WHERE u.onboarding_phase = 'Approved'
        AND inv.invited_at < NOW() - make_interval(hours => $1::int)
        AND ($2::uuid IS NULL OR u.id = $2::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages r
           WHERE r.user_id = u.id AND r.template_key = 'onboarding_reminder'
             AND r.created_at > inv.invited_at)
      LIMIT 100`,
    [waitHours(config.lifecycle.onboardingReminderHours, opts), opts.userId || null], log);

  const result = { due: rows.length, sent: 0, skipped: 0 };
  for (const u of rows) {
    const userLog = log.child({ user_id: u.id });
    const reach = await canSend('onboarding_reminder', u.id, userLog);
    if (!reach.ok) { result.skipped += 1; continue; }
    const sent = await templates.send('onboarding_reminder', {
      to: u.phone_number, user: u, inWindow: reach.inWindow,
    }, userLog);
    if (sent.sent) {
      result.sent += 1;
      await events.record('onboarding_reminder_sent', { userId: u.id, metadata: { via: sent.via } }, userLog);
    }
  }
  log.info('lifecycle.onboarding_reminders_done', result);
  return result;
}

/**
 * 48 hours after activation, a check-in, but only if the client has gone
 * quiet: someone who wrote in the last 24 hours is mid-conversation and is
 * left alone (they are looked at again on the next run).
 */
async function runHandshakePings(log = logger, opts = {}) {
  // ignoreWait also skips the "quiet for 24h" rule: the tester has just been chatting.
  const { rows } = await db.query(
    `SELECT u.*
       FROM users u
      WHERE u.onboarding_phase = 'Active'
        AND COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND u.activated_at <= NOW() - make_interval(hours => $1::int)
        AND u.activated_at > NOW() - make_interval(days => $2::int)
        AND ($3::uuid IS NULL OR u.id = $3::uuid)
        AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'handshake_ping')
        AND ($4::boolean OR NOT EXISTS (SELECT 1 FROM conversations c
                         WHERE c.user_id = u.id AND c.timestamp > NOW() - INTERVAL '24 hours'))
      LIMIT 100`,
    [waitHours(config.lifecycle.handshakeHours, opts), HANDSHAKE_MAX_AGE_DAYS,
      opts.userId || null, Boolean(opts.ignoreWait)], log);

  const result = { due: rows.length, sent: 0, skipped: 0 };
  for (const u of rows) {
    const userLog = log.child({ user_id: u.id });
    // Quiet for 24h means outside the window: only the approved template works.
    if (!config.templates.handshake_ping) { result.skipped += 1; continue; }
    const sent = await templates.send('handshake_ping', { to: u.phone_number, user: u, inWindow: false }, userLog);
    if (sent.sent) result.sent += 1;
  }
  log.info('lifecycle.handshake_pings_done', result);
  return result;
}

/**
 * Alice put options to the client, and they have not answered for 4 hours:
 * one respectful nudge. Still inside the 24-hour window, so plain text.
 *
 * Only the client's latest exchange counts: any later message from them, a
 * hand-off to a human, or a nudge already sent for that exchange means no.
 */
async function runProposalNudges(log = logger, opts = {}) {
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.phone_number, c.ai_response, c.timestamp AS proposed_at
       FROM users u
       JOIN LATERAL (
         SELECT ai_response, timestamp FROM conversations
          WHERE user_id = u.id ORDER BY timestamp DESC LIMIT 1
       ) c ON TRUE
      WHERE COALESCE(u.conversation_mode, 'ai') = 'ai'
        AND c.ai_response IS NOT NULL
        AND c.timestamp <= NOW() - make_interval(hours => $1::int)
        AND c.timestamp > NOW() - INTERVAL '20 hours'
        AND ($2::uuid IS NULL OR u.id = $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                         WHERE o.user_id = u.id AND o.template_key = 'proposal_nudge'
                           AND o.created_at > c.timestamp)
      LIMIT 200`,
    [waitHours(config.lifecycle.proposalNudgeHours, opts), opts.userId || null], log);

  const result = { candidates: rows.length, sent: 0 };
  for (const r of rows) {
    if (!PROPOSAL.test(r.ai_response)) continue;
    const userLog = log.child({ user_id: r.id });
    const sent = await templates.send('proposal_nudge', { to: r.phone_number, user: r, inWindow: true }, userLog);
    if (sent.sent) result.sent += 1;
  }
  log.info('lifecycle.proposal_nudges_done', result);
  return result;
}

module.exports = {
  STATUS_CHANGE_TEMPLATE,
  PROPOSAL,
  findOrAdoptClient,
  markTrialStarted,
  activate,
  onStatusChange,
  runOnboardingReminders,
  runHandshakePings,
  runProposalNudges,
};
