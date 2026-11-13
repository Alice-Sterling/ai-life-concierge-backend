/**
 * Admin audit trail (Project 4): one row in admin_audit_logs per /admin call.
 *
 * Mounted BEFORE adminAuth, so refused calls (bad token, blocked address,
 * read-only token) are recorded too, as actor "unauthenticated" or the token's
 * actor. The row is written when the response finishes, so it carries the
 * status code and never delays or fails the request.
 *
 * Not recorded: GET /admin/alarms. The n8n alarm polls it every five minutes;
 * 288 identical rows a day would bury the entries that matter.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|credential/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

/** Copy a request body with secrets removed and long strings cut. */
function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[${value.length} chars]` : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Short names for the calls that change something; everything else is "METHOD path". */
const ACTIONS = [
  ['POST', /^\/users\/[^/]+\/mode$/, 'conversation_mode.set'],
  ['POST', /^\/messages\/send$/, 'message.send'],
  ['POST', /^\/users\/[^/]+\/timezone$/, 'timezone.set'],
  ['POST', /^\/users\/status-changed$/, 'status.changed'],
  ['POST', /^\/tasks\/[^/]+\/status$/, 'task.status.set'],
  ['POST', /^\/calendar\/connect$/, 'calendar.connect'],
  ['POST', /^\/test\//, 'test.run'],
  ['GET', /^\/conversations\/[^/]+$/, 'conversation.read'],
  ['GET', /^\/users\/[^/]+\/context$/, 'context.read'],
  ['GET', /^\/users$/, 'users.list'],
  ['GET', /^\/inbox$/, 'inbox.read'],
  ['GET', /^\/tasks$/, 'tasks.list'],
  ['GET', /^\/audit$/, 'audit.read'],
];

function actionFor(method, path) {
  const hit = ACTIONS.find(([m, re]) => m === method && re.test(path));
  return hit ? hit[2] : `${method} ${path}`.slice(0, 128);
}

/** The client the call is about, when the route or body names one. */
function userIdFor(req, routePath = req.path) {
  const candidates = [req.auditUserId, req.params?.userId, req.body?.user_id, req.body?.userId];
  const inPath = /\/(?:users|conversations|test)\/([0-9a-f-]{36})(?:\/|$)/i.exec(routePath || '')?.[1];
  return [...candidates, inPath].find((v) => typeof v === 'string' && UUID.test(v)) || null;
}

async function write(entry, log = logger) {
  try {
    await db.query(
      `INSERT INTO admin_audit_logs
         (actor, route, user_id, action, request_body_redacted, status_code, ip, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [entry.actor, entry.route, entry.userId, entry.action, JSON.stringify(entry.body || {}),
        entry.statusCode, entry.ip, entry.requestId], log);
  } catch (err) {
    // Before migration 008 the table does not exist. The request already
    // succeeded; the structured log line below is the fallback record.
    log.warn('admin.audit_not_saved', { message: err.message, code: err.code });
  }
}

function adminAudit() {
  return (req, res, next) => {
    // Read now: once a handler throws, Express has left this router by the
    // time 'finish' fires and req.path is the full "/admin/..." path again.
    const routePath = req.path;
    const mount = req.baseUrl || '';
    res.on('finish', () => {
      if (req.method === 'OPTIONS') return;
      if (req.method === 'GET' && routePath === '/alarms') return;
      const entry = {
        actor: req.admin?.actor || 'unauthenticated',
        route: `${req.method} ${mount}${routePath}`.slice(0, 255),
        userId: userIdFor(req, routePath),
        action: actionFor(req.method, routePath),
        body: redact({
          ...(req.body && typeof req.body === 'object' ? req.body : {}),
          ...(Object.keys(req.query || {}).length ? { _query: req.query } : {}),
        }),
        statusCode: res.statusCode,
        ip: String(req.ip || '').replace(/^::ffff:/i, '').slice(0, 64) || null,
        requestId: req.requestId || null,
      };
      (req.log || logger).info('admin.audit', {
        actor: entry.actor, action: entry.action, audit_user_id: entry.userId, status: entry.statusCode,
      });
      write(entry, req.log || logger);
    });
    next();
  };
}

/** Recent entries, newest first. Read by GET /admin/audit. */
async function list({ limit = 100, userId = null, actor = null } = {}, log = logger) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await db.query(
    `SELECT id, actor, route, user_id, action, request_body_redacted, status_code, ip, request_id, timestamp
       FROM admin_audit_logs
      WHERE ($2::uuid IS NULL OR user_id = $2::uuid)
        AND ($3::text IS NULL OR actor = $3::text)
      ORDER BY timestamp DESC LIMIT $1`,
    [capped, userId, actor], log);
  return rows;
}

module.exports = { adminAudit, redact, actionFor, userIdFor, list };
