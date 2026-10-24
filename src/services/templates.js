/**
 * The status templates (Project 3, Step A).
 *
 * One registry for every fixed WhatsApp message the front door sends, so the
 * wording, the variables and the Twilio Content SID live side by side.
 *
 * Sending rules:
 *   - SID configured        -> send the Meta-approved template (works any time)
 *   - no SID, in the window -> send the same words as plain text. Every reply to
 *                              an inbound message is inside Meta's 24-hour
 *                              window, so the gate works before approval.
 *   - no SID, outside       -> cannot send. Logged, not thrown.
 *
 * Variables are numbered from {{1}} in order. Meta rejects gaps, so the brief's
 * {{9}} / {{16}} / {{17}} placeholders are renumbered here.
 */

const db = require('../db/pool');
const twilio = require('../integrations/twilio');
const { config } = require('../config');
const { logger } = require('../lib/logger');

/** The same status template is not re-sent to one person within this window. */
const REPEAT_WINDOW_HOURS = 6;

const firstName = (user) => (user?.first_name && user.first_name !== 'Explorer' ? user.first_name : 'there');
const clientKey = (user) => user?.short_id || user?.client_id || '';
const withParam = (base, name, user) =>
  `${base}${base.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(clientKey(user))}`;
const withClientId = (base, user) => withParam(base, 'client_id', user);
// Stripe payment links only carry client_reference_id through to the
// checkout.session.completed webhook, which is what activates the client.
const withPaymentRef = (base, user) => withParam(base, 'client_reference_id', user);

/**
 * name      - the template name to register in Twilio / Meta
 * variables - what is passed as contentVariables
 * text      - the plain-text twin, used before the template is approved
 */
const TEMPLATES = {
  unrecognized_user: {
    name: 'ailc_unrecognized_user_v1',
    variables: () => ({}),
    text: () =>
      'Hello. Thanks for contacting Ai Life Concierge. Access to our Founding Member programme '
      + 'is currently by invitation. To register your interest, please join our waitlist:\n'
      + config.gate.waitlistUrl,
  },
  status_waitlist: {
    name: 'ailc_status_waitlist_v1',
    variables: (u) => ({ 1: firstName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}. Thanks for registering your interest in Ai Life Concierge. `
      + "You're currently on our Founding Member waitlist. We'll contact you here as soon as "
      + 'your invitation becomes available.',
  },
  status_denied: {
    name: 'ailc_status_denied_v1',
    variables: (u) => ({ 1: firstName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}. Thank you for your interest in Ai Life Concierge. Unfortunately, `
      + "we're unable to offer you membership within our current Founding Member cohort. "
      + 'Thank you for taking the time to register your interest.',
  },
  status_approved: {
    name: 'ailc_status_approved_v1',
    // {{2}} is the dynamic suffix of the CTA button URL.
    variables: (u) => ({ 1: firstName(u), 2: clientKey(u) }),
    text: (u) =>
      `Welcome to Ai Life Concierge, ${firstName(u)}. Your Founding Member invitation is ready. `
      + 'To personalise Alice around your lifestyle and preferences, please complete your '
      + `onboarding below:\n${withClientId(config.gate.onboardingUrl, u)}`,
  },
  pending_stripe: {
    name: 'ailc_pending_stripe_v1',
    variables: (u) => ({ 1: firstName(u), 2: clientKey(u) }),
    text: (u) =>
      `Hello ${firstName(u)}, Alice here. Your lifestyle preferences are now set up. There's just `
      + 'one final step to activate your Founding Membership and complimentary six-month trial.'
      + (config.gate.paymentUrl ? `\n${withPaymentRef(config.gate.paymentUrl, u)}` : ''),
  },
  membership_inactive: {
    name: 'ailc_membership_inactive_v1',
    // Quick reply button "Contact Alice" sends: "Hi, I need help with my membership, please."
    variables: (u) => ({ 1: firstName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}. Your Ai Life Concierge membership is currently inactive, so we're `
      + 'unable to process new concierge requests at this time. If you believe this is an error '
      + 'or would like help with your membership, reply HELP.',
  },
  active_welcome: {
    name: 'ailc_active_member_welcome_v1',
    variables: (u) => ({ 1: firstName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}, Alice here. Your six-month Founding Member trial is now active and `
      + "your preferences are set up. Whenever you're ready for your first curation or need "
      + 'assistance, simply message me here. What can I take care of for you today?',
  },

  // ---- Lifecycle (src/services/lifecycle.js) -------------------------
  onboarding_reminder: {
    name: 'ailc_onboarding_reminder_v1',
    variables: (u) => ({ 1: firstName(u), 2: clientKey(u) }),
    text: (u) =>
      `Hello ${firstName(u)}, just a gentle reminder that your Founding Member invitation is `
      + 'waiting. It only takes a few minutes to personalise Alice around your lifestyle:\n'
      + withClientId(config.gate.onboardingUrl, u),
  },
  handshake_ping: {
    name: 'ailc_active_handshake_ping_v1',
    // Quick reply button: [ Ready ]
    variables: (u) => ({ 1: firstName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}, Alice here. Your 6-month Founding Member trial is officially live. `
      + "I've successfully synced your calendar and prepared a quick briefing for your week ahead, "
      + "along with your automation options. Reply 'Ready' to review it.",
  },
  datenight_ping: {
    name: 'ailc_datenight_ping_v1',
    // Quick reply buttons: [ Review Options ] | [ Skip This Week ]
    // The approved template kept the brief's numbering: {{16}} cadence, {{17}} partner
    // (checked in Twilio 24 Oct). Sending {{2}}/{{3}} made Twilio fill in its samples.
    variables: (u) => ({ 1: firstName(u), 16: cadenceWord(u), 17: partnerName(u) }),
    text: (u) =>
      `Hello ${firstName(u)}, it's time for your ${cadenceWord(u)} date night curation! I've reviewed `
      + `your calendar and prepared a few bespoke options for you and ${partnerName(u)}. `
      + "Reply 'Review' to see them, or 'Skip' to skip this week.",
  },
  // Plain text only: it goes out 4 hours after Alice's options, inside the window.
  proposal_nudge: {
    name: null,
    variables: () => ({}),
    text: (u) =>
      `Hello ${firstName(u)}, just keeping this warm. Did either of those options catch your eye, `
      + 'or would you like me to look in a different direction?',
  },
};

/** 7 -> weekly, 14 -> fortnightly, 28-31 -> monthly, as the brief maps {{16}}. */
function cadenceWord(user) {
  const d = Number(user?.date_night_cadence);
  if (d === 7) return 'weekly';
  if (d === 14) return 'fortnightly';
  if (d >= 28 && d <= 31) return 'monthly';
  return 'regular';
}

/** The partner's name from the preferences, wherever intake put it. */
function partnerName(user) {
  const p = user?.preferences || {};
  const name = p.date_night?.partner_name || p.partner_name || p.lifestyle?.partner_name;
  return name && String(name).trim() ? String(name).trim() : 'your partner';
}

/** Was this template sent to this user recently? Stops five "hello?"s getting five replies. */
async function sentRecently(userId, key, log = logger, hours = REPEAT_WINDOW_HOURS) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM outbound_messages
      WHERE user_id = $1 AND template_key = $2
        AND created_at > NOW() - make_interval(hours => $3::int)
      LIMIT 1`,
    [userId, key, hours], log);
  return rows.length > 0;
}

/**
 * Is the client inside Meta's 24-hour window, i.e. did they write to us in
 * the last 24 hours? Inside it a plain-text twin can stand in for a template
 * that is not approved yet.
 */
async function inWindow(userId, log = logger) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM conversations
      WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '23 hours 30 minutes'
      LIMIT 1`,
    [userId], log);
  return rows.length > 0;
}

/**
 * Send a status template.
 *
 * @param {string} key one of TEMPLATES
 * @param {object} opts
 * @param {string} opts.to        phone number, with or without whatsapp:
 * @param {object} [opts.user]    the user row (null for an unknown number)
 * @param {boolean} [opts.inWindow=true] replying to an inbound message?
 * @returns {Promise<{sent: boolean, text: string, via: 'template'|'text'|'inline'|'none'}>}
 *   via 'inline' means Twilio is not configured and the caller should put
 *   `text` in the TwiML response instead.
 */
async function send(key, { to, user = null, inWindow = true, requestId = null } = {}, log = logger) {
  const tpl = TEMPLATES[key];
  if (!tpl) throw new Error(`Unknown template: ${key}`);

  const text = tpl.text(user);
  const sid = config.templates[key];

  let via;
  let ok;
  if (!twilio.isConfigured()) {
    if (!inWindow) return { sent: false, text, via: 'none' };
    // The caller replies in TwiML. Still recorded below, so the repeat
    // window works the same with or without the Twilio API.
    via = 'inline';
    ok = true;
  } else if (sid) {
    via = 'template';
    ok = await twilio.sendTemplate(to, sid, tpl.variables(user), log);
  } else if (inWindow) {
    via = 'text';
    ok = await twilio.sendWhatsApp(to, text, log);
  } else {
    // Outside the window Meta drops free text, so sending it would only look
    // like it worked.
    log.warn('template.not_configured', { template: key, env: `TWILIO_TPL_${key.toUpperCase()}` });
    return { sent: false, text, via: 'none' };
  }

  if (user?.id) {
    await db.query(
      `INSERT INTO outbound_messages (user_id, body, status, request_id, template_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, text, ok ? (via === 'inline' ? 'inline' : 'sent') : 'failed', requestId, key], log);
  }

  log.info('template.sent', { template: key, via, ok, user_id: user?.id ?? null });
  return { sent: ok, text, via };
}

module.exports = { TEMPLATES, REPEAT_WINDOW_HOURS, sentRecently, inWindow, cadenceWord, partnerName, send };
