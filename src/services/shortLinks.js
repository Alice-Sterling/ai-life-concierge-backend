/**
 * Short links for WhatsApp: <PUBLIC_BASE_URL>/go/<code> -> the real booking page.
 *
 * Uber and shop links run to hundreds of characters; in a chat they look like
 * noise. Alice sends the short one, the client taps it, GET /go/:code answers
 * with a redirect. The desk still gets the full link (Airtable Booking Link).
 *
 * Storage is the existing `events` table (event 'short_link', metadata
 * { code, url }), so no migration; events never sync to Airtable. A tap is
 * recorded as 'short_link_opened'. Anything that fails -> the full link is
 * used instead: a long link is better than a dead one.
 */

const crypto = require('crypto');
const db = require('../db/pool');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const CREATED = 'short_link';
const OPENED = 'short_link_opened';
const CODE = /^[A-Za-z0-9_-]{8}$/;

/** 8 URL-safe characters, 48 random bits. */
const newCode = () => crypto.randomBytes(6).toString('base64url');

const isWebUrl = (url) => /^https?:\/\/\S+$/i.test(String(url || ''));

/**
 * @returns {Promise<string>} the short link, or the original url if one cannot be made
 */
async function shorten(url, { userId = null } = {}, log = logger) {
  if (!isWebUrl(url) || !config.publicBaseUrl) return url;
  const code = newCode();
  try {
    await db.query(
      `INSERT INTO events (user_id, event_name, metadata) VALUES ($1, $2, $3::jsonb)`,
      [userId, CREATED, JSON.stringify({ code, url })],
      log
    );
    return `${config.publicBaseUrl.replace(/\/$/, '')}/go/${code}`;
  } catch (err) {
    log.warn('short_link.create_failed', { message: err.message });
    return url;
  }
}

/** @returns {Promise<string|null>} the full url for a code, recording the tap */
async function resolve(code, log = logger) {
  if (!CODE.test(String(code || ''))) return null;
  const { rows } = await db.query(
    `SELECT user_id, metadata->>'url' AS url FROM events
      WHERE event_name = $1 AND metadata->>'code' = $2
      ORDER BY timestamp DESC LIMIT 1`,
    [CREATED, code],
    log
  );
  const row = rows[0];
  if (!row || !isWebUrl(row.url)) return null;
  try {
    await db.query(
      `INSERT INTO events (user_id, event_name, metadata) VALUES ($1, $2, $3::jsonb)`,
      [row.user_id, OPENED, JSON.stringify({ code })],
      log
    );
  } catch (err) {
    log.warn('short_link.open_not_recorded', { message: err.message });
  }
  return row.url;
}

module.exports = { shorten, resolve, newCode, isWebUrl, CODE };
