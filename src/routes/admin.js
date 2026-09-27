/**
 * Internal admin API (brief section 2E).
 *
 *   GET  /admin/users                  recent users and their onboarding phase
 *   GET  /admin/tasks                  recent tasks, optionally filtered by status
 *   GET  /admin/conversations/:userId  recent chat history for one user
 *   POST /admin/users/:userId/mode     toggle conversation_mode between ai and human
 *
 * JSON only. No HTML dashboard, as specified. Every route sits behind the admin
 * bearer token and a tight rate limit, applied where the router is mounted.
 */

const express = require('express');
const users = require('../services/users');
const tasks = require('../services/tasks');
const conversations = require('../services/conversations');
const timezone = require('../services/timezone');

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

module.exports = router;
