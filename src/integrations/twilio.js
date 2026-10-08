/**
 * Twilio client: WhatsApp sending and inbound webhook signature validation.
 */

const twilio = require('twilio');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const client =
  config.twilio.accountSid && config.twilio.authToken
    ? twilio(config.twilio.accountSid, config.twilio.authToken)
    : null;

function isConfigured() {
  return Boolean(client && config.twilio.whatsappFrom);
}

/**
 * Verify that a webhook genuinely came from Twilio.
 *
 * Twilio signs each request with the auth token over the full URL plus the sorted
 * POST body. Without this check, anyone who learns the webhook URL can
 * impersonate any customer's WhatsApp number.
 *
 * The URL must be reconstructed exactly as Twilio saw it. Railway terminates TLS
 * upstream, so req.protocol reports http and the signature will not match unless
 * X-Forwarded-Proto is honoured — hence PUBLIC_BASE_URL being preferred.
 */
function validateSignature(req) {
  if (!config.twilio.authToken) return false;

  const signature = req.get('x-twilio-signature');
  if (!signature) return false;

  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  const url = config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/$/, '')}${req.originalUrl}`
    : `${proto}://${host}${req.originalUrl}`;

  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {});
}

// Both ends need the whatsapp: prefix. Twilio rejects a bare number with a
// confusing "channel mismatch", and whether the prefix is present depends on
// how the environment variable happened to be typed.
const withChannel = (n) => (String(n).startsWith('whatsapp:') ? String(n) : `whatsapp:${n}`);

/** One send path for text and templates, so both log and fail the same way. */
async function send(to, content, log) {
  if (!isConfigured()) {
    log.warn('twilio.not_configured', { integration: 'twilio' });
    return false;
  }
  try {
    const msg = await client.messages.create({
      from: withChannel(config.twilio.whatsappFrom),
      to: withChannel(to),
      ...content,
    });
    log.info('twilio.message_sent', { integration: 'twilio', message_sid: msg.sid });
    return true;
  } catch (err) {
    log.error('twilio.send_failed', {
      integration: 'twilio',
      message: err.message,
      code: err.code,
    });
    return false;
  }
}

/**
 * Send a free-form WhatsApp message. Meta only delivers it inside the 24-hour
 * window that opens when the client last wrote to us.
 * @returns {Promise<boolean>} whether Twilio accepted it
 */
async function sendWhatsApp(to, body, log = logger) {
  return send(to, { body }, log);
}

/**
 * Send a Meta-approved template through the Content API. Works outside the
 * 24-hour window, which makes it the only way to start a conversation.
 *
 * @param {string} contentSid HX... from the Twilio Content Template Builder
 * @param {object} variables  {"1": "Sam", "2": "Ai-ABC123"} - numbered from 1, in order
 * @returns {Promise<boolean>} whether Twilio accepted it
 */
async function sendTemplate(to, contentSid, variables = {}, log = logger) {
  return send(to, { contentSid, contentVariables: JSON.stringify(variables) }, log);
}

/** Probe: fetch the account record. Read-only and cheap. */
async function healthCheck() {
  if (!client) return { status: 'not_configured', configured: false };
  const startedAt = Date.now();
  try {
    const account = await client.api.accounts(config.twilio.accountSid).fetch();
    return {
      status: account.status === 'active' ? 'ok' : 'degraded',
      configured: true,
      latency_ms: Date.now() - startedAt,
      account_status: account.status,
      sender_configured: Boolean(config.twilio.whatsappFrom),
    };
  } catch (err) {
    return {
      status: 'error',
      configured: true,
      latency_ms: Date.now() - startedAt,
      error: err.message,
    };
  }
}

module.exports = { client, isConfigured, validateSignature, sendWhatsApp, sendTemplate, healthCheck };
