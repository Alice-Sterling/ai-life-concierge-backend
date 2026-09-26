/**
 * Outbound email.
 *
 * NOTE ON SENDGRID: the brief asks for a SendGrid health check. The prototype
 * sends through nodemailer over SMTP and has no SendGrid client; SENDGRID_API_KEY
 * is read but never used to send anything.
 *
 * Rather than report a green light for a service that is not wired up, the health
 * check reports on the transport that actually sends mail (SMTP) and states
 * separately whether a SendGrid key is present. See README "Schema deviations".
 */

const nodemailer = require('nodemailer');
const { config } = require('../config');
const { logger } = require('../lib/logger');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.email.host || !config.email.user || !config.email.pass) return null;

  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return transporter;
}

function isConfigured() {
  return Boolean(getTransporter() && config.email.from);
}

/** @returns {Promise<boolean>} whether the message was accepted for delivery */
async function send({ to, subject, text, html }, log = logger) {
  const tx = getTransporter();
  if (!tx || !config.email.from) {
    log.warn('email.not_configured', { integration: 'email' });
    return false;
  }
  try {
    const info = await tx.sendMail({ from: config.email.from, to, subject, text, html });
    log.info('email.sent', { integration: 'email', message_id: info.messageId });
    return true;
  } catch (err) {
    log.error('email.send_failed', { integration: 'email', message: err.message });
    return false;
  }
}

/** Probe: SMTP handshake and authentication. Sends nothing. */
async function healthCheck() {
  const tx = getTransporter();
  const sendgridKeyPresent = Boolean(config.email.sendgridApiKey);

  if (!tx) {
    return {
      status: 'not_configured',
      configured: false,
      transport: 'smtp',
      sendgrid_key_present: sendgridKeyPresent,
      note: 'SMTP (nodemailer) is the active transport. No SendGrid client is wired up.',
    };
  }

  const startedAt = Date.now();
  try {
    await tx.verify();
    return {
      status: 'ok',
      configured: true,
      transport: 'smtp',
      latency_ms: Date.now() - startedAt,
      sendgrid_key_present: sendgridKeyPresent,
    };
  } catch (err) {
    return {
      status: 'error',
      configured: true,
      transport: 'smtp',
      latency_ms: Date.now() - startedAt,
      error: err.message,
      sendgrid_key_present: sendgridKeyPresent,
    };
  }
}

module.exports = { isConfigured, send, healthCheck };
