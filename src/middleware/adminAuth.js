/**
 * Bearer-token guard for the /admin/* endpoints.
 *
 * A single shared token, as the brief specifies. Adequate for an internal ops
 * API; it is not per-user auth and gives no audit trail of who called what.
 */

const crypto = require('crypto');
const { config } = require('../config');

/**
 * Compare two strings without leaking their similarity through timing.
 *
 * A plain `===` returns faster the earlier it finds a mismatch, which over many
 * requests reveals the token one character at a time. Lengths are compared via
 * the digests so the comparison itself is always over equal-length buffers.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function adminAuth() {
  return (req, res, next) => {
    // An unset token must never mean "allow everyone". If the deployment has no
    // ADMIN_API_TOKEN, the admin API is closed rather than open.
    if (!config.admin.apiToken) {
      req.log?.error('admin.auth_unconfigured', { detail: 'ADMIN_API_TOKEN is not set' });
      return res.status(503).json({
        error: 'Admin API is not configured',
        request_id: req.requestId,
      });
    }

    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : (req.get('x-admin-token') || '').trim();

    if (!token || !safeEqual(token, config.admin.apiToken)) {
      req.log?.warn('admin.auth_failed', { has_token: Boolean(token) });
      return res.status(401).json({ error: 'Unauthorized', request_id: req.requestId });
    }

    req.isAdmin = true;
    return next();
  };
}

module.exports = { adminAuth };
