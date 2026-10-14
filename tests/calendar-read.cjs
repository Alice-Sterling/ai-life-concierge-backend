/**
 * Reading a client's calendar with their own stored token, and refreshing it.
 *
 *   SB_URL=postgres://... node tests/calendar-read.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 * Google and Microsoft are never called: fetch is stubbed for their hosts.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
delete process.env.MS_CLIENT_ID;
delete process.env.MS_CLIENT_SECRET;

const fs = require('fs');
const path = require('path');

const calls = [];
let googleEvents = () => ({ status: 200, body: { items: [] } });
let tokenReply = () => ({ status: 200, body: { access_token: 'ya29.REFRESHED', expires_in: 3599 } });
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const r = u.startsWith('https://oauth2.googleapis.com/token') ? tokenReply
    : u.startsWith('https://www.googleapis.com/') ? googleEvents
      : u.startsWith('https://graph.microsoft.com/') ? () => ({ status: 200, body: { value: [
        { subject: 'Board meeting', start: { dateTime: '2026-10-20T09:00:00.0000000' }, end: { dateTime: '2026-10-20T10:00:00.0000000' }, showAs: 'busy' },
        { subject: 'Lunch (tentative free)', start: { dateTime: '2026-10-20T12:00:00.0000000' }, end: { dateTime: '2026-10-20T13:00:00.0000000' }, showAs: 'free' },
      ] } })
        : null;
  if (!r) return realFetch(url, opts);
  calls.push({ url: u, auth: opts.headers?.Authorization, body: opts.body });
  const x = r();
  return new Response(JSON.stringify(x.body), { status: x.status });
};

const db = require('../src/db/pool');
const crypto = require('../src/lib/crypto');
const calendar = require('../src/services/calendar');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

async function user(provider, { access, refresh = null, expiresInSec }) {
  const { rows } = await db.query(
    `INSERT INTO users (first_name, phone_number, calendar_provider, calendar_connected,
                        calendar_access_token_enc, calendar_refresh_token_enc, calendar_token_expires_at)
     VALUES ('Cal', '+4477009' || floor(random() * 1000000)::text, $1, true, $2, $3, NOW() + make_interval(secs => $4::int))
     RETURNING id`,
    [provider, access ? crypto.encrypt(access) : null, refresh ? crypto.encrypt(refresh) : null, expiresInSec]);
  return rows[0].id;
}

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql']) {
    await db.query(read('db', 'sql', f));
  }
  const S = '2026-10-20T00:00:00Z', E = '2026-10-21T00:00:00Z';

  console.log('\nGOOGLE, FRESH TOKEN');
  googleEvents = () => ({ status: 200, body: { items: [
    { summary: 'Dinner with Sam', start: { dateTime: '2026-10-20T19:00:00+01:00' }, end: { dateTime: '2026-10-20T21:00:00+01:00' } },
    { summary: 'Cancelled thing', status: 'cancelled', start: { dateTime: '2026-10-20T08:00:00Z' }, end: { dateTime: '2026-10-20T09:00:00Z' } },
    { summary: 'Reminder (free)', transparency: 'transparent', start: { dateTime: '2026-10-20T10:00:00Z' }, end: { dateTime: '2026-10-20T10:15:00Z' } },
    { summary: 'Holiday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } },
  ] } });
  const g = await user('google', { access: 'ya29.FRESH', refresh: '1//r', expiresInSec: 3000 });
  let r = await calendar.readEvents(g, S, E);
  check('ok', r.ok, true);
  check('used the client\'s own token', calls.at(-1).auth, 'Bearer ya29.FRESH');
  check('asked for titles and times only', calls.at(-1).url.includes('fields=items'), true);
  check('cancelled and "free" events dropped', r.events.length, 2);
  check('event title kept', r.events[0].title, 'Dinner with Sam');
  check('all-day event flagged', r.events[1].all_day, true);
  check('no token refresh needed', calls.some((c) => c.url.includes('oauth2.googleapis.com/token')), false);

  console.log('\nGOOGLE, EXPIRED TOKEN -> REFRESH');
  const before = calls.length;
  const g2 = await user('google', { access: 'ya29.OLD', refresh: '1//refresh-me', expiresInSec: 30 });
  r = await calendar.readEvents(g2, S, E);
  const tokenCall = calls.slice(before).find((c) => c.url.includes('oauth2.googleapis.com/token'));
  check('refreshed first', Boolean(tokenCall), true);
  check('with the stored refresh token', String(tokenCall?.body).includes('refresh_token=1%2F%2Frefresh-me'), true);
  check('then read with the new token', calls.at(-1).auth, 'Bearer ya29.REFRESHED');
  const row = (await db.query(
    'SELECT calendar_access_token_enc, calendar_token_expires_at FROM users WHERE id = $1', [g2])).rows[0];
  check('new token stored encrypted', crypto.decrypt(row.calendar_access_token_enc), 'ya29.REFRESHED');
  check('new expiry about an hour out', new Date(row.calendar_token_expires_at) - Date.now() > 3500e3, true);

  console.log('\nREVOKED ACCESS');
  tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
  const g3 = await user('google', { access: 'ya29.DEAD', refresh: '1//revoked', expiresInSec: -60 });
  r = await calendar.readEvents(g3, S, E);
  check('not ok -> falls back to the old path', r.reason, 'no_usable_token');
  check('marked not connected, so Alice may offer to reconnect',
    (await db.query('SELECT calendar_connected FROM users WHERE id = $1', [g3])).rows[0].calendar_connected, false);

  console.log('\nOUTLOOK');
  const o = await user('outlook', { access: 'eyJ.OUTLOOK', expiresInSec: 3000 });
  r = await calendar.readEvents(o, S, E);
  check('ok', r.ok, true);
  check('own token', calls.at(-1).auth, 'Bearer eyJ.OUTLOOK');
  check('"free" event dropped', r.events.length, 1);
  check('time marked as UTC', r.events[0].start, '2026-10-20T09:00:00.0000000Z');
  const o2 = await user('outlook', { access: 'eyJ.OLD', refresh: 'M.r', expiresInSec: -10 });
  check('expired + no Microsoft app configured -> no usable token', (await calendar.readEvents(o2, S, E)).reason, 'no_usable_token');

  console.log('\nGUARDS');
  const none = await user('google', { access: null, expiresInSec: 3000 });
  check('no stored token -> not ok', (await calendar.readEvents(none, S, E)).ok, false);
  check('bad window -> not ok', (await calendar.readEvents(g, E, S)).reason, 'invalid_window');
  googleEvents = () => ({ status: 500, body: {} });
  check('provider error -> not ok', (await calendar.readEvents(g, S, E)).reason, 'provider_error');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
