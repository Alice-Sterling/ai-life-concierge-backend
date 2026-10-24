/**
 * Internal admin API (brief section 2E).
 *
 *   GET  /admin/users                  recent users and their onboarding phase
 *   GET  /admin/tasks                  recent tasks, optionally filtered by status
 *   GET  /admin/conversations/:userId  recent chat history for one user
 *   POST /admin/users/:userId/mode     toggle conversation_mode between ai and human
 *   POST /admin/calendar/connect       store a calendar OAuth handshake (called by n8n)
 *   POST /admin/users/status-changed   Airtable status changed -> template (called by n8n)
 *   POST /admin/test/:userId/date-night-due  make a test user's date night due now
 *   POST /admin/test/:userId/run             run the proactive jobs now, for that user only
 *
 * JSON only. No HTML dashboard, as specified. Every route sits behind the admin
 * bearer token and a tight rate limit, applied where the router is mounted.
 */

const express = require('express');
const users = require('../services/users');
const tasks = require('../services/tasks');
const conversations = require('../services/conversations');
const timezone = require('../services/timezone');
const calendar = require('../services/calendar');
const lifecycle = require('../services/lifecycle');
const dateNight = require('../services/dateNight');
const db = require('../db/pool');
const { config } = require('../config');

const router = express.Router();

// Postgres rejects a malformed uuid with a 500-looking error, so the shape is
// checked first and a clear 400 returned instead.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wrap an async handler so a rejected promise reaches the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/users', wrap(async (req, res) => {
  const rows = await users.listRecent({ limit: req.query.limit }, req.log);
  res.json({ count: rows.length, users: rows, request_id: req.requestId });
}));

router.get('/tasks', wrap(async (req, res) => {
  const { status } = req.query;
  if (status && !tasks.STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Expected one of: ${tasks.STATUSES.join(', ')}`,
      request_id: req.requestId,
    });
  }
  const rows = await tasks.listRecent({ status, limit: req.query.limit }, req.log);
  res.json({ count: rows.length, status: status || 'all', tasks: rows, request_id: req.requestId });
}));

router.get('/conversations/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!UUID.test(userId)) {
    return res.status(400).json({ error: 'userId must be a UUID', request_id: req.requestId });
  }

  const user = await users.findById(userId, req.log);
  if (!user) {
    return res.status(404).json({ error: 'User not found', request_id: req.requestId });
  }

  const history = await conversations.getHistory(userId, { limit: req.query.limit }, req.log);
  res.json({
    user: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      phone_number: user.phone_number,
      conversation_mode: user.conversation_mode,
      onboarding_phase: user.onboarding_phase,
    },
    count: history.length,
    conversations: history,
    request_id: req.requestId,
  });
}));

router.post('/users/:userId/mode', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!UUID.test(userId)) {
    return res.status(400).json({ error: 'userId must be a UUID', request_id: req.requestId });
  }

  const mode = req.body?.conversation_mode ?? req.body?.mode;
  if (!users.CONVERSATION_MODES.includes(mode)) {
    return res.status(400).json({
      error: `conversation_mode must be one of: ${users.CONVERSATION_MODES.join(', ')}`,
      request_id: req.requestId,
    });
  }

  const updated = await users.setConversationMode(
    userId, mode, { requestId: req.requestId }, req.log);

  if (!updated) {
    return res.status(404).json({ error: 'User not found', request_id: req.requestId });
  }

  res.json({
    ok: true,
    user_id: updated.id,
    conversation_mode: updated.conversation_mode,
    request_id: req.requestId,
  });
}));

/**
 * Move a task through its lifecycle.
 *
 * Operators work tasks in Airtable, which has no way to write back to Postgres.
 * This is the bridge: an Airtable or n8n automation calls it when a task's
 * status changes. Completing a date-night task schedules the client's next one.
 */
router.post('/tasks/:taskId/status', wrap(async (req, res) => {
  const { taskId } = req.params;
  if (!UUID.test(taskId)) {
    return res.status(400).json({ error: 'taskId must be a UUID', request_id: req.requestId });
  }

  const status = req.body?.status;
  if (!tasks.STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${tasks.STATUSES.join(', ')}`,
      request_id: req.requestId,
    });
  }

  const updated = await tasks.updateStatus(taskId, status, req.log);
  if (!updated) {
    return res.status(404).json({ error: 'Task not found', request_id: req.requestId });
  }

  res.json({
    ok: true,
    task_id: updated.task_id,
    status: updated.status,
    completed_at: updated.completed_at,
    request_id: req.requestId,
  });
}));

/**
 * Manual timezone override.
 *
 * The agent normally handles this itself via the set_active_timezone tool.
 * This is the operator's escape hatch when it gets it wrong, or when a client
 * tells a human rather than Alice.
 */
router.post('/users/:userId/timezone', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!UUID.test(userId)) {
    return res.status(400).json({ error: 'userId must be a UUID', request_id: req.requestId });
  }

  const tz = req.body?.active_timezone ?? req.body?.timezone;
  const updated = await timezone.setForUser(userId, tz, { requestId: req.requestId }, req.log);

  if (!updated) {
    return res.status(404).json({ error: 'User not found', request_id: req.requestId });
  }

  res.json({ ok: true, user_id: userId, ...updated, request_id: req.requestId });
}));

/**
 * Store a finished calendar OAuth handshake.
 *
 * Called by the n8n onboarding workflow straight after it swaps the code for
 * tokens. The tokens are encrypted here and never echoed back.
 *
 *   { client_id, provider: google|outlook, access_token, refresh_token?, expires_in?, scope? }
 */
router.post('/calendar/connect', wrap(async (req, res) => {
  const b = req.body || {};
  const result = await calendar.saveConnection({
    clientId: b.client_id,
    provider: b.provider,
    accessToken: b.access_token,
    refreshToken: b.refresh_token || null,
    expiresIn: b.expires_in,
    scope: b.scope || null,
  }, { requestId: req.requestId }, req.log);

  if (!result) {
    return res.status(404).json({ error: 'No user with that client_id', request_id: req.requestId });
  }

  res.json({ ok: true, ...result, request_id: req.requestId });
}));

/**
 * A client's status was changed in Airtable. n8n polls Airtable and calls
 * this; the backend copies the status and sends the brief's template.
 * Repeats within 24 hours are suppressed, so a re-poll is harmless.
 *
 *   { client_id?, phone?, status }
 */
router.post('/users/status-changed', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.client_id && !b.phone) {
    return res.status(400).json({ error: 'client_id or phone is required', request_id: req.requestId });
  }
  const result = await lifecycle.onStatusChange({
    clientId: b.client_id || null, phone: b.phone || null, status: b.status,
  }, { requestId: req.requestId }, req.log);

  if (!result) {
    return res.status(404).json({ error: 'No user with that client_id or phone', request_id: req.requestId });
  }
  res.json({ ok: true, ...result, request_id: req.requestId });
}));

/**
 * Live-test tools. The proactive jobs wait hours or days by design; these run
 * them now for ONE test account (config.testTools.userIds), so a real phone can
 * check every message in minutes. Any other user gets 403.
 */
const TEST_JOBS = {
  onboarding_reminder: (log, opts) => lifecycle.runOnboardingReminders(log, opts),
  handshake_ping: (log, opts) => lifecycle.runHandshakePings(log, opts),
  proposal_nudge: (log, opts) => lifecycle.runProposalNudges(log, opts),
  date_night: (log, opts) => dateNight.runDueSweep(log, { userId: opts.userId, ignoreHour: true }),
};

function testUser(req, res) {
  const { userId } = req.params;
  if (!UUID.test(userId)) {
    res.status(400).json({ error: 'userId must be a UUID', request_id: req.requestId });
    return null;
  }
  if (!config.testTools.userIds.includes(userId.toLowerCase())) {
    res.status(403).json({ error: 'Not a test account', request_id: req.requestId });
    return null;
  }
  return userId;
}

/** { cadence_days? } -> date_night_cadence set (default: keep, else 14), next_date_due_at = now. */
router.post('/test/:userId/date-night-due', wrap(async (req, res) => {
  const userId = testUser(req, res);
  if (!userId) return;
  const cadence = req.body?.cadence_days == null ? null : dateNight.normaliseCadence(req.body.cadence_days);
  const { rows } = await db.query(
    `UPDATE users
        SET date_night_cadence = COALESCE($2::int, date_night_cadence, $3::int),
            next_date_due_at = NOW()
      WHERE id = $1
      RETURNING id, date_night_cadence, next_date_due_at`,
    [userId, cadence, dateNight.DEFAULT_CADENCE_DAYS], req.log);
  if (!rows[0]) return res.status(404).json({ error: 'User not found', request_id: req.requestId });
  res.json({ ok: true, ...rows[0], user_id: rows[0].id, request_id: req.requestId });
}));

/**
 * { jobs?: [onboarding_reminder|handshake_ping|proposal_nudge|date_night], ignore_wait? }
 *
 * Runs the chosen jobs (default: all) for this user only. The date-night ping
 * ignores the morning-hour rule; ignore_wait also treats the 24h/48h/4h waits
 * as over. The feature switches are reported, and a job whose switch is off
 * still runs: this is how a switch is checked before turning it on.
 */
router.post('/test/:userId/run', wrap(async (req, res) => {
  const userId = testUser(req, res);
  if (!userId) return;
  const jobs = req.body?.jobs ?? Object.keys(TEST_JOBS);
  const unknown = [].concat(jobs).filter((j) => !TEST_JOBS[j]);
  if (unknown.length) {
    return res.status(400).json({
      error: `Unknown job(s): ${unknown.join(', ')}. Expected: ${Object.keys(TEST_JOBS).join(', ')}`,
      request_id: req.requestId,
    });
  }

  const opts = { userId, ignoreWait: req.body?.ignore_wait === true };
  const results = {};
  for (const job of [].concat(jobs)) {
    results[job] = await TEST_JOBS[job](req.log.child({ test_job: job }), opts);
  }
  req.log.info('admin.test_run', { user_id: userId, jobs, ignore_wait: opts.ignoreWait });
  res.json({
    ok: true,
    user_id: userId,
    ignore_wait: opts.ignoreWait,
    switches: {
      onboarding_reminder: config.lifecycle.onboardingReminder,
      handshake_ping: config.lifecycle.handshakePing,
      proposal_nudge: config.lifecycle.proposalNudge,
      date_night_ping: config.lifecycle.dateNightPing,
    },
    results,
    request_id: req.requestId,
  });
}));

module.exports = router;
