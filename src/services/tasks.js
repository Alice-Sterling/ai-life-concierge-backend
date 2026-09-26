/**
 * Human-in-the-loop task queue.
 *
 * A task is a request the agent decided it should not execute alone: a
 * high-stakes booking, a trial sign-up, or an explicit concierge hand-off.
 * Postgres is the source of truth; each task is mirrored into Airtable for the
 * ops team to work.
 */

const db = require('../db/pool');
const airtable = require('../integrations/airtable');
const events = require('./events');
const { logger } = require('../lib/logger');

const STATUSES = ['new', 'triaged', 'in_progress', 'completed', 'failed'];
const PRIORITIES = ['normal', 'high', 'vip'];
const CATEGORIES = ['date_night', 'client_event', 'general'];

/**
 * Create a task and mirror it to Airtable.
 *
 * The Airtable push is awaited but never fatal: the row exists in Postgres
 * either way, and a failed sync is recoverable by re-running it. Losing the
 * task because Airtable was down is not.
 */
async function create(
  { userId, sourceMessage, aiSummary, priority = 'normal', category = 'general', requiresHuman = true, assignedTo = null, requestId = null },
  log = logger
) {
  if (!PRIORITIES.includes(priority)) priority = 'normal';
  if (!CATEGORIES.includes(category)) category = 'general';

  const { rows } = await db.query(
    `INSERT INTO tasks (user_id, source_message, ai_summary, priority, category,
                        requires_human, assigned_to, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, sourceMessage, aiSummary, priority, category, requiresHuman, assignedTo, requestId],
    log
  );
  const task = rows[0];

  log.info('task.created', { task_id: task.task_id, user_id: userId, category, priority });
  await events.record(events.EVENT.HUMAN_HANDOFF_CREATED, {
    userId,
    requestId,
    metadata: { task_id: task.task_id, category, priority },
  }, log);

  await syncToAirtable(task, log);
  return task;
}

/** Move a task through its lifecycle. completed_at is maintained by a trigger. */
async function updateStatus(taskId, status, log = logger) {
  if (!STATUSES.includes(status)) {
    throw Object.assign(new Error(`Invalid task status: ${status}`), { status: 400 });
  }
  const { rows } = await db.query(
    'UPDATE tasks SET status = $2 WHERE task_id = $1 RETURNING *',
    [taskId, status],
    log
  );
  if (!rows[0]) return null;

  log.info('task.status_changed', { task_id: taskId, status });
  await syncToAirtable(rows[0], log);
  return rows[0];
}

/**
 * Push a task to Airtable and remember the record id.
 *
 * The id is stored so later updates patch the same row instead of creating
 * duplicates, and so the two systems can be reconciled by hand if they drift.
 */
async function syncToAirtable(task, log = logger) {
  if (!airtable.isConfigured()) return;

  try {
    // Airtable links by record id, so the user's profile row must be resolved
    // first for the relational field on the Tasks table.
    const { rows } = await db.query(
      'SELECT id, client_id, short_id, phone_number FROM users WHERE id = $1',
      [task.user_id],
      log
    );
    const user = rows[0];
    const userRecordId = user
      ? await airtable.findRecordId(
          require('../config').config.airtable.userTableRef,
          'Client ID',
          user.client_id || user.short_id,
          log
        )
      : null;

    const recordId = await airtable.syncTask(task, userRecordId, log);
    if (recordId && recordId !== task.airtable_record_id) {
      await db.query(
        'UPDATE tasks SET airtable_record_id = $2 WHERE task_id = $1',
        [task.task_id, recordId],
        log
      );
    }
  } catch (err) {
    log.warn('task.airtable_sync_failed', { task_id: task.task_id, message: err.message });
  }
}

/** Recent tasks, newest first. Used by GET /admin/tasks. */
async function listRecent({ status = null, limit = 50 } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = status
    ? await db.query(
        `SELECT t.*, u.first_name, u.last_name, u.phone_number
           FROM tasks t JOIN users u ON u.id = t.user_id
          WHERE t.status = $1 ORDER BY t.created_at DESC LIMIT $2`,
        [status, capped], log)
    : await db.query(
        `SELECT t.*, u.first_name, u.last_name, u.phone_number
           FROM tasks t JOIN users u ON u.id = t.user_id
          ORDER BY t.created_at DESC LIMIT $1`,
        [capped], log);
  return rows;
}

module.exports = { STATUSES, PRIORITIES, CATEGORIES, create, updateStatus, listRecent, syncToAirtable };
