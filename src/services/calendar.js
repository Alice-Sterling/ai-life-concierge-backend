/**
 * Calendar connection: encrypted token storage and the calendar's timezone.
 *
 * The n8n onboarding workflow runs the Google / Outlook OAuth exchange, then
 * hands the tokens here (POST /admin/calendar/connect). They are encrypted
 * with src/lib/crypto.js before they touch the database, and the user is
 * flagged calendar_connected so Alice never asks them to reconnect.
 *
 * Tokens are never logged and never returned.
 */

const db = require('../db/pool');
const crypto = require('../lib/crypto');
const events = require('./events');
const { isValidTimezone } = require('./timezone');
const { logger } = require('../lib/logger');

const PROVIDERS = ['google', 'outlook'];

const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Microsoft Graph usually reports Windows zone names. The common ones a UK
 * concierge's clients live in are mapped; anything else is accepted only if
 * it is already an IANA name, otherwise the timezone is left unchanged.
 */
const WINDOWS_TO_IANA = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'Etc/UTC',
};

function normaliseProvider(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'google' || s === 'gcal' || s.includes('google')) return 'google';
  if (s === 'outlook' || s === 'ms' || s.includes('outlook') || s.includes('microsoft')) return 'outlook';
  return null;
}

function toIana(name) {
  if (!name) return null;
  const s = String(name).trim();
  const mapped = WINDOWS_TO_IANA[s] || s;
  return isValidTimezone(mapped) ? mapped : null;
}

/**
 * Ask the provider which timezone the client's calendar is in.
 *
 * Google: the events list carries the primary calendar's timeZone and needs
 * only the calendar.events scope the onboarding flow already requests.
 * `fields=timeZone` keeps every event out of the response.
 *
 * Outlook: mailboxSettings needs MailboxSettings.Read. Without that scope
 * Graph answers 403 and the timezone is simply left as it was.
 *
 * Never throws: a missing timezone must not fail the connection itself.
 *
 * @returns {Promise<string|null>} an IANA name, or null
 */
async function fetchTimezone(provider, accessToken, log = logger) {
  const url = provider === 'google'
    ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=timeZone'
    : 'https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone';

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('calendar.timezone_fetch_failed', { provider, status: res.status });
      return null;
    }
    const body = await res.json();
    const tz = toIana(provider === 'google' ? body.timeZone : body.value);
    if (!tz) log.warn('calendar.timezone_unrecognised', { provider, raw: provider === 'google' ? body.timeZone : body.value });
    return tz;
  } catch (err) {
    log.warn('calendar.timezone_fetch_failed', { provider, message: err.message });
    return null;
  }
}

/**
 * Store a completed OAuth handshake against the user with this client id.
 *
 * @param {object} input
 * @param {string} input.clientId      Airtable "Client ID" (users.client_id or users.short_id)
 * @param {string} input.provider      google | outlook
 * @param {string} input.accessToken
 * @param {string} [input.refreshToken] kept from the previous handshake when absent
 * @param {number} [input.expiresIn]   seconds, as the token endpoint returns it
 * @param {string} [input.scope]
 * @returns {Promise<object|null>} null when no user has that client id
 */
async function saveConnection(
  { clientId, provider, accessToken, refreshToken = null, expiresIn = null, scope = null },
  { requestId = null } = {},
  log = logger
) {
  const prov = normaliseProvider(provider);
  if (!clientId || typeof clientId !== 'string') {
    throw Object.assign(new Error('client_id is required'), { status: 400 });
  }
  if (!prov) {
    throw Object.assign(new Error(`provider must be one of: ${PROVIDERS.join(', ')}`), { status: 400 });
  }
  if (!accessToken || typeof accessToken !== 'string') {
    throw Object.assign(new Error('access_token is required'), { status: 400 });
  }
  if (!crypto.isConfigured()) {
    // Refuse rather than store a credential in clear text.
    throw Object.assign(new Error('Token encryption is not configured'), { status: 503 });
  }

  const seconds = Number(expiresIn);
  const expiresAt = Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000)
    : null;

  // A website sign-up may not be in Postgres yet: found, linked by phone, or
  // created from Airtable, so the login is never lost (lifecycle.findOrAdoptClient).
  const client = await require('./lifecycle').findOrAdoptClient(clientId, log);
  if (!client) return null;
  const userId = client.id;

  const timezone = await fetchTimezone(prov, accessToken, log);

  // Google sends a refresh token only on the first consent. A later handshake
  // without one must not wipe the one already stored.
  const { rows } = await db.query(
    `UPDATE users
        SET calendar_access_token_enc  = $2,
            calendar_refresh_token_enc = COALESCE($3, calendar_refresh_token_enc),
            calendar_token_expires_at  = $4,
            calendar_token_scope       = $5,
            calendar_token_updated_at  = NOW(),
            calendar_provider          = $6,
            calendar_connected         = true,
            calendar_connected_at      = NOW(),
            calendar_timezone          = COALESCE($7::varchar, calendar_timezone),
            active_timezone            = COALESCE($7::varchar, active_timezone),
            active_timezone_set_at     = CASE WHEN $7::varchar IS NULL THEN active_timezone_set_at ELSE NOW() END
      WHERE id = $1
      RETURNING id, calendar_provider, calendar_connected, active_timezone`,
    [
      userId,
      crypto.encrypt(accessToken),
      refreshToken ? crypto.encrypt(refreshToken) : null,
      expiresAt,
      scope,
      prov,
      timezone,
    ],
    log
  );

  log.info('calendar.connected', { user_id: userId, provider: prov, timezone_from_calendar: Boolean(timezone) });
  await events.record(events.EVENT.CALENDAR_CONNECTED, {
    userId, requestId, metadata: { provider: prov, timezone },
  }, log);

  return {
    user_id: rows[0].id,
    provider: rows[0].calendar_provider,
    calendar_connected: rows[0].calendar_connected,
    active_timezone: rows[0].active_timezone,
    timezone_source: timezone ? 'calendar' : 'unchanged',
  };
}

// ---------------------------------------------------------------------------
// Reading the client's calendar with their own tokens (Project 3: "inject
// per-user tokens for calendar calls"). Replaces a shared, single-account
// connection: every client's availability comes from their own calendar.
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = {
  google: 'https://oauth2.googleapis.com/token',
  outlook: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};
const OUTLOOK_SCOPE = 'offline_access User.Read Calendars.ReadWrite MailboxSettings.Read';

/** Refresh this long before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_EVENTS = 100;

function oauthClient(provider) {
  const { config } = require('../config');
  const c = config.calendarOAuth?.[provider] || {};
  return c.clientId && c.clientSecret ? c : null;
}

/**
 * A usable access token for this user, refreshing it when it is about to
 * expire. Null when the user has no stored tokens, or the token has expired
 * and cannot be refreshed (no refresh token, or no OAuth client configured).
 *
 * @returns {Promise<{token: string, provider: string}|null>}
 */
async function getAccessToken(userId, log = logger) {
  if (!crypto.isConfigured()) return null;
  const { rows } = await db.query(
    `SELECT calendar_provider, calendar_access_token_enc, calendar_refresh_token_enc, calendar_token_expires_at
       FROM users WHERE id = $1`, [userId], log);
  const row = rows[0];
  const provider = normaliseProvider(row?.calendar_provider);
  if (!row?.calendar_access_token_enc || !provider) return null;

  const expiresAt = row.calendar_token_expires_at ? new Date(row.calendar_token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return { token: crypto.decrypt(row.calendar_access_token_enc), provider };
  }

  const client = oauthClient(provider);
  if (!row.calendar_refresh_token_enc || !client) {
    log.warn('calendar.token_expired_no_refresh', { provider, has_refresh: Boolean(row.calendar_refresh_token_enc) });
    return null;
  }

  const form = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: crypto.decrypt(row.calendar_refresh_token_enc),
    grant_type: 'refresh_token',
  });
  if (provider === 'outlook') form.set('scope', OUTLOOK_SCOPE);

  try {
    const res = await fetch(TOKEN_ENDPOINT[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS * 2),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      // invalid_grant = the client revoked access. Only then do they need to reconnect.
      log.warn('calendar.token_refresh_failed', { provider, status: res.status, error: body.error || null });
      if (body.error === 'invalid_grant') {
        await db.query('UPDATE users SET calendar_connected = false WHERE id = $1', [userId], log);
      }
      return null;
    }

    const seconds = Number(body.expires_in) || 3600;
    await db.query(
      `UPDATE users
          SET calendar_access_token_enc  = $2,
              calendar_refresh_token_enc = COALESCE($3, calendar_refresh_token_enc),
              calendar_token_expires_at  = NOW() + make_interval(secs => $4::int),
              calendar_token_updated_at  = NOW()
        WHERE id = $1`,
      [userId, crypto.encrypt(body.access_token),
        body.refresh_token ? crypto.encrypt(body.refresh_token) : null, seconds],
      log);
    log.info('calendar.token_refreshed', { provider });
    return { token: body.access_token, provider };
  } catch (err) {
    log.warn('calendar.token_refresh_failed', { provider, message: err.message });
    return null;
  }
}

async function fetchJson(url, headers, log, provider) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS * 2) });
  if (!res.ok) {
    log.warn('calendar.read_failed', { provider, status: res.status });
    return null;
  }
  return res.json();
}

/** A Google event as readEvents returns it, or null when it should be left out. */
function mapGoogleEvent(e, { includeFree = false, withLocation = false } = {}) {
  if (e.status === 'cancelled') return null;
  const free = e.transparency === 'transparent';
  if (free && !includeFree) return null;
  return {
    title: e.summary || '(busy)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    all_day: Boolean(e.start?.date && !e.start?.dateTime),
    ...(includeFree ? { free } : {}),
    ...(withLocation ? { location: e.location || null } : {}),
  };
}

/** An Outlook (Graph) event as readEvents returns it, or null when it should be left out. */
function mapOutlookEvent(e, { includeFree = false, withLocation = false } = {}) {
  if (e.isCancelled) return null;
  const free = e.showAs === 'free';
  if (free && !includeFree) return null;
  return {
    title: e.subject || '(busy)',
    // Graph returns UTC without a zone suffix when asked for UTC.
    start: e.start?.dateTime ? `${e.start.dateTime.replace(/Z?$/, '')}Z` : null,
    end: e.end?.dateTime ? `${e.end.dateTime.replace(/Z?$/, '')}Z` : null,
    all_day: Boolean(e.isAllDay),
    ...(includeFree ? { free } : {}),
    ...(withLocation ? { location: e.location?.displayName || null } : {}),
  };
}

/**
 * The client's events between two instants, read with their own token.
 * By default titles and times of busy events only, which is what Alice sees.
 *
 * The proactive scans (milestones, travel) also need events marked "free"
 * (birthdays and anniversaries usually are) and the location. Those come back
 * only when asked for, and are for the scan's own matching: they are never
 * passed to Alice or stored.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeFree=false]  keep events marked free / transparent
 * @param {boolean} [opts.withLocation=false] add each event's location
 * @returns {Promise<{ok: true, provider, busy: {start,end}[], events: {title,start,end,all_day}[]}
 *                  | {ok: false, reason: string}>}
 */
async function readEvents(userId, startTime, endTime, log = logger, opts = {}) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { ok: false, reason: 'invalid_window' };
  }

  const access = await getAccessToken(userId, log);
  if (!access) return { ok: false, reason: 'no_usable_token' };
  const auth = { Authorization: `Bearer ${access.token}` };

  let items;
  try {
    if (access.provider === 'google') {
      const qs = new URLSearchParams({
        timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true',
        orderBy: 'startTime', maxResults: String(MAX_EVENTS),
        fields: `items(summary,start,end,status,transparency${opts.withLocation ? ',location' : ''})`,
      });
      const body = await fetchJson(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, auth, log, 'google');
      if (!body) return { ok: false, reason: 'provider_error' };
      items = (body.items || []).map((e) => mapGoogleEvent(e, opts)).filter(Boolean);
    } else {
      const qs = new URLSearchParams({
        startDateTime: start.toISOString(), endDateTime: end.toISOString(),
        $select: `subject,start,end,showAs,isCancelled,isAllDay${opts.withLocation ? ',location' : ''}`,
        $top: String(MAX_EVENTS), $orderby: 'start/dateTime',
      });
      const body = await fetchJson(
        `https://graph.microsoft.com/v1.0/me/calendarView?${qs}`,
        { ...auth, Prefer: 'outlook.timezone="UTC"' }, log, 'outlook');
      if (!body) return { ok: false, reason: 'provider_error' };
      items = (body.value || []).map((e) => mapOutlookEvent(e, opts)).filter(Boolean);
    }
  } catch (err) {
    log.warn('calendar.read_failed', { provider: access.provider, message: err.message });
    return { ok: false, reason: 'provider_error' };
  }

  return {
    ok: true,
    provider: access.provider,
    // "Free" events never count as busy, even when the scan asked for them.
    busy: items.filter((i) => !i.free).map(({ start: s, end: e }) => ({ start: s, end: e })),
    events: items,
  };
}

module.exports = {
  PROVIDERS, normaliseProvider, toIana, fetchTimezone, saveConnection, getAccessToken, readEvents,
  mapGoogleEvent, mapOutlookEvent,
};
