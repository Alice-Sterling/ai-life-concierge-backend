/**
 * Alarms: what went wrong in the last few minutes, with a likely fix.
 *
 * Read by the n8n "ALC - Alarms" workflow (GET /admin/alarms), which also
 * checks from outside that the backend answers at all and reads Twilio's own
 * error log, then emails the desk and the developer. This module only covers
 * what the backend itself can see in Postgres:
 *
 *   webhook_failed     a WhatsApp message crashed (the client got "Apologies, I hit a problem")
 *   message_failed     a queued message failed processing (retried, then parked)
 *   message_stuck      messages waiting longer than they should: the worker is not running
 *   send_failed        a reply or template could not be handed to Twilio
 *   automation_failed  a timed job (date night, lifecycle) failed for a client
 *
 * If Postgres itself is down, this whole check fails, and n8n reports that.
 * Message text is never included: only error text, times, request ids and
 * the client's first name, so the email is safe to forward.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const MAX_EXAMPLES = 5;

/** Error text -> what probably broke and what to do. First match wins. */
const HINTS = [
  [/password authentication failed|role .* does not exist|no pg_hba/i,
    'The backend cannot log in to Postgres. If the database password changed, redeploy the backend so it reads the new one (Railway -> backend -> Deployments -> Redeploy).'],
  [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|Connection terminated|connect.*5432|terminating connection/i,
    'The backend cannot reach Postgres. Check the Postgres service in Railway is running; after a Postgres restart the backend reconnects by itself within a minute.'],
  [/anthropic|claude|invalid x-api-key|authentication_error|credit balance/i,
    'The AI (Anthropic) call failed. Check ANTHROPIC_API_KEY in Railway and the billing/credit balance in console.anthropic.com; a revoked key needs a new one, then a redeploy.'],
  [/\b429\b|rate.?limit|too many requests/i,
    'A provider is rate-limiting us. Usually clears by itself; if it repeats, check which service (Twilio, Anthropic, Airtable) and its usage limits.'],
  [/airtable/i,
    'An Airtable call failed. Check AIRTABLE_API_KEY in Railway is still valid and the base/table names have not changed.'],
  [/twilio|\b2000[0-9]\b|\b63\d{3}\b|\b21\d{3}\b/i,
    "A Twilio call failed. Open Twilio -> Monitor -> Errors for the code; check TWILIO_AUTH_TOKEN in Railway if it was rotated."],
  [/calendar|google|graph\.microsoft|invalid_grant|refresh token/i,
    "A calendar call failed. If it says invalid_grant, the client's calendar login expired or was revoked: ask them to reconnect their calendar once."],
];
const DEFAULT_HINT = 'Open Railway -> backend -> Logs and search for the request ID below to see the full error.';

function hintFor(text) {
  const t = String(text || '');
  for (const [re, hint] of HINTS) if (re.test(t)) return hint;
  return DEFAULT_HINT;
}

/** The most common hint across a set of error texts. */
function bestHint(texts) {
  const counts = new Map();
  for (const t of texts) {
    const h = hintFor(t);
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  let best = DEFAULT_HINT;
  let n = 0;
  for (const [h, c] of counts) if (c > n || (c === n && best === DEFAULT_HINT)) { best = h; n = c; }
  return best;
}

const clip = (s, n = 300) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/**
 * @param {object} [opts]
 * @param {number} [opts.sinceMinutes=6] look-back window
 * @returns {Promise<{ok: true, since_minutes: number, checked_at: string, issues: object[]}>}
 */
async function collect({ sinceMinutes = 6 } = {}, log = logger) {
  const minutes = Math.min(Math.max(Number.parseInt(sinceMinutes, 10) || 6, 1), 1440);
  const issues = [];

  // 1. Crashed WhatsApp messages (recorded by the webhook's catch).
  const { rows: crashed } = await db.query(
    `SELECT e.timestamp, e.request_id, e.metadata->>'message' AS error, u.first_name
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.event_name = 'webhook_failed' AND e.timestamp > NOW() - make_interval(mins => $1::int)
      ORDER BY e.timestamp DESC`,
    [minutes], log);
  if (crashed.length) {
    issues.push({
      key: 'webhook_failed',
      severity: 'critical',
      title: `${crashed.length} WhatsApp message(s) crashed: the client got "Apologies, I hit a problem"`,
      count: crashed.length,
      fix: bestHint(crashed.map((r) => r.error)),
      examples: crashed.slice(0, MAX_EXAMPLES).map((r) => ({
        at: r.timestamp, client: r.first_name || null, request_id: r.request_id, error: clip(r.error),
      })),
    });
  }

  // 2. Queued messages that failed processing.
  const { rows: failed } = await db.query(
    `SELECT p.received_at, p.request_id, p.state::text AS state, p.attempts, p.last_error, u.first_name
       FROM pending_messages p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.last_error IS NOT NULL AND p.state IN ('pending', 'failed')
        AND p.received_at > NOW() - make_interval(mins => $1::int)
      ORDER BY p.received_at DESC`,
    [minutes], log);
  if (failed.length) {
    const parked = failed.filter((r) => r.state === 'failed').length;
    issues.push({
      key: 'message_failed',
      severity: 'critical',
      title: `${failed.length} incoming message(s) failed processing${parked ? ` (${parked} given up after retries)` : ' (being retried)'}`,
      count: failed.length,
      fix: bestHint(failed.map((r) => r.last_error)),
      examples: failed.slice(0, MAX_EXAMPLES).map((r) => ({
        at: r.received_at, client: r.first_name || null, request_id: r.request_id,
        state: r.state, attempts: r.attempts, error: clip(r.last_error),
      })),
    });
  }

  // 3. A backlog: messages waiting more than 3 minutes (the batch waits ~7 seconds).
  const { rows: stuck } = await db.query(
    `SELECT COUNT(*)::int AS n, MIN(received_at) AS oldest
       FROM pending_messages
      WHERE state IN ('pending', 'processing') AND received_at < NOW() - INTERVAL '3 minutes'`,
    [], log);
  if (stuck[0]?.n > 0) {
    issues.push({
      key: 'message_stuck',
      severity: 'critical',
      title: `${stuck[0].n} incoming message(s) waiting more than 3 minutes for a reply`,
      count: stuck[0].n,
      fix: 'The message worker is not getting through the queue. Check Railway -> backend -> Logs for "batch." errors; a redeploy restarts the worker.',
      examples: [{ oldest_received_at: stuck[0].oldest }],
    });
  }

  // 4. Replies and templates Twilio did not accept.
  const { rows: sends } = await db.query(
    `SELECT COALESCE(o.template_key, 'reply') AS kind, COUNT(*)::int AS n, MAX(o.created_at) AS last_at,
            MAX(o.error_code) AS error_code, MAX(o.error_message) AS error_message,
            (ARRAY_AGG(u.first_name ORDER BY o.created_at DESC))[1] AS last_client
       FROM outbound_messages o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status = 'failed' AND o.created_at > NOW() - make_interval(mins => $1::int)
      GROUP BY 1 ORDER BY n DESC`,
    [minutes], log);
  if (sends.length) {
    const total = sends.reduce((s, r) => s + r.n, 0);
    issues.push({
      key: 'send_failed',
      severity: 'warning',
      title: `${total} WhatsApp send(s) failed: ${sends.map((r) => `${r.kind} x${r.n}`).join(', ')}`,
      count: total,
      fix: 'Twilio did not accept the message. Open Twilio -> Monitor -> Errors for the error code. Common: 63016 = the client is outside the 24-hour window and the template has no approved SID; 20003 = TWILIO_AUTH_TOKEN in Railway is wrong.',
      examples: sends.slice(0, MAX_EXAMPLES).map((r) => ({
        kind: r.kind, count: r.n, last_at: r.last_at, last_client: r.last_client || null,
        error: clip([r.error_code, r.error_message].filter(Boolean).join(' ')) || null,
      })),
    });
  }

  // 5. Timed jobs that failed for a client.
  const { rows: jobs } = await db.query(
    `SELECT automation_type, COUNT(*)::int AS n, MAX(timestamp) AS last_at,
            (ARRAY_AGG(error_details ORDER BY timestamp DESC))[1] AS last_error
       FROM automation_logs
      WHERE status = 'failed' AND timestamp > NOW() - make_interval(mins => $1::int)
      GROUP BY 1 ORDER BY n DESC`,
    [minutes], log);
  if (jobs.length) {
    const total = jobs.reduce((s, r) => s + r.n, 0);
    issues.push({
      key: 'automation_failed',
      severity: 'warning',
      title: `${total} automation run(s) failed: ${jobs.map((r) => `${r.automation_type} x${r.n}`).join(', ')}`,
      count: total,
      fix: bestHint(jobs.map((r) => r.last_error)),
      examples: jobs.slice(0, MAX_EXAMPLES).map((r) => ({
        automation: r.automation_type, count: r.n, last_at: r.last_at, error: clip(r.last_error),
      })),
    });
  }

  return { ok: true, since_minutes: minutes, checked_at: new Date().toISOString(), issues };
}

module.exports = { HINTS, hintFor, bestHint, collect };
