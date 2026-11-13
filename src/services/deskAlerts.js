/**
 * "A client wrote while they are with a human" (Project 4, Scenario B).
 *
 * Alice is silent in human mode, so somebody on the desk has to know there is
 * a message waiting. This emails the desk and, when SLACK_WEBHOOK_URL is set,
 * posts to Slack. One alert per client per ALERT_GAP_MINUTES: a client typing
 * five lines is one alert, not five.
 *
 * The gap is kept in memory. After a restart the next message alerts again,
 * which errs on the side of telling the desk.
 */

const email = require('../integrations/email');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const ALERT_GAP_MINUTES = 10;
const lastAlertAt = new Map();

/** Should this client's message alert now? Records the alert time when true. */
function shouldAlert(userId, now = Date.now()) {
  const last = lastAlertAt.get(userId) || 0;
  if (now - last < ALERT_GAP_MINUTES * 60_000) return false;
  lastAlertAt.set(userId, now);
  return true;
}

function alertText(user, message, requestId) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
  const base = config.publicBaseUrl ? config.publicBaseUrl.replace(/\/$/, '') : '';
  return {
    name,
    subject: `WAITING FOR A HUMAN: ${name}`,
    text: `${name} wrote while in human mode. Alice is not replying.\n\n`
      + `Phone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}\n\n`
      + `Message:\n${String(message || '').slice(0, 500) || '(no text)'}\n\n`
      + `Reply from the Command Center, or hand the client back to Alice`
      + `${base ? ` (POST ${base}/admin/users/${user.id}/mode)` : ''}.\n`
      + `Alice takes the client back by herself when the human window ends.\n\n`
      + `Request ID: ${requestId || ''}`,
  };
}

/**
 * Tell the desk. Best-effort: never throws into the webhook.
 * @returns {Promise<{alerted: boolean, email?: boolean, slack?: boolean}>}
 */
async function clientWaiting(user, message, { requestId = null } = {}, log = logger) {
  if (!user?.id || !shouldAlert(user.id)) return { alerted: false };
  const { name, subject, text } = alertText(user, message, requestId);
  const out = { alerted: true, email: false, slack: false };

  try {
    if (email.isConfigured()) {
      await email.send({ to: config.admin.alertEmail, subject, text }, log);
      out.email = true;
    }
  } catch (err) {
    log.warn('desk_alert.email_failed', { message: err.message });
  }

  if (config.admin.slackWebhookUrl) {
    try {
      const res = await fetch(config.admin.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No message text in Slack: the channel is wider than the desk inbox.
        body: JSON.stringify({ text: `:raising_hand: *${name}* is waiting for a human reply (Alice is paused).` }),
        signal: AbortSignal.timeout(5_000),
      });
      out.slack = res.ok;
    } catch (err) {
      log.warn('desk_alert.slack_failed', { message: err.message });
    }
  }

  log.info('desk_alert.client_waiting', { user_id: user.id, email: out.email, slack: out.slack });
  return out;
}

module.exports = { ALERT_GAP_MINUTES, shouldAlert, alertText, clientWaiting, _reset: () => lastAlertAt.clear() };
