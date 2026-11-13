/**
 * Guards for the /admin/* endpoints (hardened in Project 4).
 *
 *   adminCors()   lets the Command Center's browser origin call the API
 *   adminAuth()   who is calling: a named token with a scope, and its IP
 *   requireWrite  read-only tokens may only GET
 *
 * Tokens
 *   ADMIN_TOKENS      JSON list of { actor, token, scope: read|write, ips? }.
 *                     One per caller, so the audit log says who did what and
 *                     one caller's token can be replaced without the others.
 *   ADMIN_API_TOKEN   the original shared token. Still accepted, as actor
 *                     "legacy-admin" with write scope, so n8n keeps working.
 *
 * Actor
 *   The token names the calling system ("command-center"). The person using
 *   it can be added with the X-Admin-Actor header ("alice@..."); the audit log
 *   then records "command-center:alice@...". The header alone proves nothing:
 *   it is only read after the token has been accepted.
 *
 * IP allowlist
 *   ADMIN_IP_ALLOWLIST (all tokens) and a token's own `ips`. Exact addresses
 *   or IPv4 CIDR ranges. Empty means any address, which is the default:
 *   hosted callers (Lovable, n8n cloud) do not have fixed addresses.
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

/** Every token this deployment accepts, the legacy one last. */
function knownTokens() {
  const out = [...(config.admin.tokens || [])];
  if (config.admin.apiToken) {
    out.push({ actor: 'legacy-admin', token: config.admin.apiToken, scope: 'write', ips: [] });
  }
  return out;
}

/** Which token is this? Every candidate is compared, so timing does not say which matched. */
function identify(token) {
  let match = null;
  for (const t of knownTokens()) {
    if (safeEqual(token, t.token) && !match) match = t;
  }
  return match;
}

const normaliseIp = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '');

const ipv4ToInt = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

/** Does `ip` match one entry: an exact address or an IPv4 CIDR range? */
function ipMatches(ip, rule) {
  const addr = normaliseIp(ip);
  const r = normaliseIp(rule);
  if (!addr || !r) return false;
  if (!r.includes('/')) return addr.toLowerCase() === r.toLowerCase();
  const [base, bitsRaw] = r.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  if (a == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** An empty list allows everyone; otherwise the address must match an entry. */
function ipAllowed(ip, rules) {
  if (!rules || rules.length === 0) return true;
  return rules.some((rule) => ipMatches(ip, rule));
}

/** "alice@example.com" from the header, cut down to safe characters. */
function cleanActorHeader(raw) {
  const v = String(raw || '').trim().slice(0, 64);
  return /^[A-Za-z0-9@._+\- ]+$/.test(v) ? v : null;
}

function adminAuth() {
  return (req, res, next) => {
    // An unset token must never mean "allow everyone". If the deployment has no
    // admin token at all, the admin API is closed rather than open.
    if (knownTokens().length === 0) {
      req.log?.error('admin.auth_unconfigured', { detail: 'ADMIN_API_TOKEN / ADMIN_TOKENS is not set' });
      return res.status(503).json({
        error: 'Admin API is not configured',
        request_id: req.requestId,
      });
    }

    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : (req.get('x-admin-token') || '').trim();

    const known = token ? identify(token) : null;
    if (!known) {
      req.log?.warn('admin.auth_failed', { has_token: Boolean(token) });
      return res.status(401).json({ error: 'Unauthorized', request_id: req.requestId });
    }

    if (!ipAllowed(req.ip, config.admin.ipAllowlist) || !ipAllowed(req.ip, known.ips)) {
      req.log?.warn('admin.ip_not_allowed', { actor: known.actor });
      req.admin = { actor: known.actor, system: known.actor, scope: known.scope, denied: 'ip' };
      return res.status(403).json({ error: 'This address may not call the admin API', request_id: req.requestId });
    }

    const person = cleanActorHeader(req.get('x-admin-actor'));
    req.isAdmin = true;
    req.admin = {
      actor: person ? `${known.actor}:${person}` : known.actor,
      system: known.actor,
      scope: known.scope,
    };
    return next();
  };
}

/** Read-only tokens may look, not touch. Mount after adminAuth(). */
function requireWrite() {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.admin?.scope === 'write') return next();
    req.log?.warn('admin.write_refused', { actor: req.admin?.actor });
    return res.status(403).json({ error: 'This token is read-only', request_id: req.requestId });
  };
}

/**
 * CORS for the Command Center. Only origins listed in ADMIN_CORS_ORIGINS get
 * the headers; with none listed (the default) a browser cannot call /admin.
 * The token still decides access: CORS only tells the browser it may ask.
 */
function adminCors() {
  return (req, res, next) => {
    const origin = req.get('origin');
    const allowed = Boolean(origin) && config.admin.corsOrigins.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Actor, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
    return next();
  };
}

module.exports = {
  adminAuth, requireWrite, adminCors,
  safeEqual, identify, ipMatches, ipAllowed, cleanActorHeader,
};
