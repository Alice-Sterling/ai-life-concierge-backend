/**
 * Twilio client: WhatsApp sending and inbound webhook signature validation.
 */

const twilio = require('twilio');
const { config } = require('../config');
const { logger } = require('../lib/logger');
const messages = require('../services/messages');

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
 * X-Forwarded-Proto is honoured.
 *
 * The service answers on more than one domain (the Railway one and the custom
 * ones), and PUBLIC_BASE_URL may name a different domain from the one Twilio's
 * webhook is set to. So two URLs are tried: PUBLIC_BASE_URL + path, and the
 * domain this request actually arrived on. Either one still needs a valid
 * signature made with the auth token.
 */
function signatureUrls(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const urls = [];
  if (config.publicBaseUrl) urls.push(`${config.publicBaseUrl.replace(/\/$/, '')}${req.originalUrl}`);
  if (host) urls.push(`${proto}://${host}${req.originalUrl}`);
  return [...new Set(urls)];
}

function validateSignature(req) {
  if (!config.twilio.authToken) return false;

  const signature = req.get('x-twilio-signature');
  if (!signature) return false;

  return signatureUrls(req).some((url) =>
    twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {}));
}

// Both ends need the whatsapp: prefix. Twilio rejects a bare number with a
// confusing "channel mismatch", and whether the prefix is present depends on
// how the environment variable happened to be typed.
const withChannel = (n) => (String(n).startsWith('whatsapp:') ? String(n) : `whatsapp:${n}`);

/**
 * One send path for text and templates, so both log and fail the same way.
 *
 * Every accepted send is also written to the message log (the Command
 * Center's chat view), here rather than in each caller so none can forget.
 * `meta`: { userId?, text?, senderType?, templateKey?, actor?, requestId? }.
 * meta.text is the readable text of a template; meta.log = false skips the log.
 */
async function send(to, content, log, meta = {}) {
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
    if (meta.log !== false) {
      await messages.outboundSent({
        to,
        userId: meta.userId || null,
        content: content.body || meta.text || '',
        senderType: meta.senderType || 'alice',
        metadata: {
          twilio_sid: msg.sid,
          ...(meta.templateKey ? { template_key: meta.templateKey } : {}),
          ...(meta.actor ? { actor: meta.actor } : {}),
          ...(meta.requestId ? { request_id: meta.requestId } : {}),
          ...(meta.flags || {}),
        },
      }, log);
    }
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
async function sendWhatsApp(to, body, log = logger, meta = {}) {
  return send(to, { body }, log, meta);
}

/**
 * Send one file (image or PDF) with an optional caption, inside the same
 * 24-hour window. Twilio downloads the file from mediaUrl when it sends, so the
 * link must be reachable from the internet for at least that long.
 * @returns {Promise<boolean>} whether Twilio accepted it
 */
async function sendWhatsAppMedia(to, body, mediaUrl, log = logger, meta = {}) {
  return send(to, { ...(body ? { body } : {}), mediaUrl: [mediaUrl] }, log, meta);
}

/**
 * Send a Meta-approved template through the Content API. Works outside the
 * 24-hour window, which makes it the only way to start a conversation.
 *
 * @param {string} contentSid HX... from the Twilio Content Template Builder
 * @param {object} variables  {"1": "Sam", "2": "Ai-ABC123"} - numbered from 1, in order
 * @returns {Promise<boolean>} whether Twilio accepted it
 */
async function sendTemplate(to, contentSid, variables = {}, log = logger, meta = {}) {
  return send(to, { contentSid, contentVariables: JSON.stringify(variables) }, log, meta);
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

module.exports = { client, isConfigured, validateSignature, sendWhatsApp, sendWhatsAppMedia, sendTemplate, healthCheck };
