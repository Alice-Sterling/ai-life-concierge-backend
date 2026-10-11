/**
 * Tests for the calendar connection endpoint (POST /admin/calendar/connect).
 *
 *   SB_URL=postgres://... node tests/calendar.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 * Google and Microsoft are never called: fetch is stubbed for their hosts.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64); // 32 bytes of hex, test only
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

// ---- provider stub: everything else (the app under test) goes to real fetch
const realFetch = global.fetch;
const providerCalls = [];
let googleReply = () => ({ status: 200, body: { timeZone: 'America/New_York' } });
let graphReply = () => ({ status: 200, body: { value: 'GMT Standard Time' } });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const stub = u.startsWith('https://www.googleapis.com/') ? googleReply
    : u.startsWith('https://graph.microsoft.com/') ? graphReply : null;
  if (!stub) return realFetch(url, opts);
  providerCalls.push({ url: u, auth: opts.headers?.Authorization });
  const r = stub();
  if (r.throw) throw new Error(r.throw);
  return new Response(JSON.stringify(r.body || {}), { status: r.status });
};

const { createApp } = require('../src/app');
const db = require('../src/db/pool');
const crypto = require('../src/lib/crypto');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let server, base, pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};
const AUTH = { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' };

const connect = async (body, headers = AUTH) => {
  const res = await realFetch(`${base}/admin/calendar/connect`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const userRow = async (id) => (await db.query(
  `SELECT calendar_access_token_enc, calendar_refresh_token_enc, calendar_token_expires_at,
          calendar_token_scope, calendar_provider, calendar_connected, calendar_connected_at,
          calendar_timezone, active_timezone, active_timezone_set_at
     FROM users WHERE id = $1`, [id])).rows[0];

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  await db.query(read('db', 'sql', '001a_prepare.sql'));
  await db.query(read('db', 'sql', '001b_finalize.sql'));
  await db.query(read('db', 'sql', '003_timezone_and_tokens.sql'));
  await db.query(read('db', 'sql', '004_message_batching.sql'));
  await db.query(read('db', 'sql', '006_calendar_connection.sql'));
  // Idempotent: the migration must survive a second run.
  await db.query(read('db', 'sql', '006_calendar_connection.sql'));

  const { rows: [g] } = await db.query(
    `INSERT INTO users (first_name, phone_number, client_id) VALUES ('Gina','+447700900501','Ai-GOOGLE01') RETURNING id`);
  const { rows: [o] } = await db.query(
    `INSERT INTO users (first_name, phone_number, short_id) VALUES ('Olly','+447700900502','Ai-OUTLOOK1') RETURNING id`);
  const { rows: [x] } = await db.query(
    `INSERT INTO users (first_name, phone_number, client_id) VALUES ('Xena','+447700900503','Ai-NOTZ0001') RETURNING id`);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nSCHEMA');
  const fresh = await userRow(x.id);
  check('calendar_connected defaults to false', fresh.calendar_connected, false);
  check('calendar_timezone starts empty', fresh.calendar_timezone, null);

  console.log('\nAUTH AND VALIDATION');
  check('no token -> 401', (await connect({ client_id: 'Ai-GOOGLE01' }, { 'Content-Type': 'application/json' })).status, 401);
  check('missing client_id -> 400', (await connect({ provider: 'google', access_token: 't' })).status, 400);
  check('unknown provider -> 400', (await connect({ client_id: 'Ai-GOOGLE01', provider: 'yahoo', access_token: 't' })).status, 400);
  check('missing access_token -> 400', (await connect({ client_id: 'Ai-GOOGLE01', provider: 'google' })).status, 400);
  check('unknown client_id -> 404', (await connect({ client_id: 'Ai-NOBODY', provider: 'google', access_token: 't' })).status, 404);
  check('validation failures never reached a provider', providerCalls.length, 0);

  console.log('\nGOOGLE HANDSHAKE');
  const ACCESS = 'ya29.google-access-SECRET-111';
  const REFRESH = '1//google-refresh-SECRET-222';
  const before = Date.now();
  const r1 = await connect({
    client_id: 'Ai-GOOGLE01', provider: 'google', access_token: ACCESS,
    refresh_token: REFRESH, expires_in: 3599, scope: 'https://www.googleapis.com/auth/calendar.events',
  });
  check('200', r1.status, 200);
  check('reports connected', r1.json?.calendar_connected, true);
  check('reports provider google', r1.json?.provider, 'google');
  check('reports the calendar timezone', r1.json?.active_timezone, 'America/New_York');
  check('timezone_source = calendar', r1.json?.timezone_source, 'calendar');
  check('response never echoes the access token', r1.text.includes('SECRET'), false);

  const call = providerCalls[0] || {};
  check('asked Google for the timezone only', call.url?.includes('fields=timeZone'), true);
  check('with the client\'s own token', call.auth, `Bearer ${ACCESS}`);

  const g1 = await userRow(g.id);
  check('access token stored encrypted', crypto.decrypt(g1.calendar_access_token_enc), ACCESS);
  check('refresh token stored encrypted', crypto.decrypt(g1.calendar_refresh_token_enc), REFRESH);
  check('raw column has no plaintext', g1.calendar_access_token_enc.toString('utf8').includes('SECRET'), false);
  const expMs = new Date(g1.calendar_token_expires_at).getTime() - before;
  check('expiry is about an hour out', expMs > 3590e3 && expMs < 3610e3, true);
  check('scope saved', g1.calendar_token_scope, 'https://www.googleapis.com/auth/calendar.events');
  check('calendar_connected = true', g1.calendar_connected, true);
  check('calendar_connected_at set', g1.calendar_connected_at instanceof Date, true);
  check('calendar_provider = google', g1.calendar_provider, 'google');
  check('calendar_timezone saved', g1.calendar_timezone, 'America/New_York');
  check('active_timezone follows the calendar', g1.active_timezone, 'America/New_York');
  check('active_timezone_set_at stamped', g1.active_timezone_set_at instanceof Date, true);

  const ev = await db.query(`SELECT metadata FROM events WHERE user_id = $1 AND event_name = 'calendar_connected'`, [g.id]);
  check('calendar_connected event recorded', ev.rows.length, 1);
  check('event metadata holds no token', JSON.stringify(ev.rows[0]?.metadata).includes('SECRET'), false);

  console.log('\nRE-CONNECT WITHOUT A REFRESH TOKEN');
  const r2 = await connect({ client_id: 'Ai-GOOGLE01', provider: 'Google Calendar', access_token: 'ya29.second-access' });
  check('200', r2.status, 200);
  const g2 = await userRow(g.id);
  check('access token replaced', crypto.decrypt(g2.calendar_access_token_enc), 'ya29.second-access');
  check('old refresh token kept', crypto.decrypt(g2.calendar_refresh_token_enc), REFRESH);
  check('"Google Calendar" normalised to google', g2.calendar_provider, 'google');

  console.log('\nOUTLOOK HANDSHAKE (matched on short_id)');
  const r3 = await connect({ client_id: 'Ai-OUTLOOK1', provider: 'outlook', access_token: 'eyJ.outlook', refresh_token: 'M.R3_outlook', expires_in: 3600 });
  check('200', r3.status, 200);
  check('Windows "GMT Standard Time" -> Europe/London', r3.json?.active_timezone, 'Europe/London');
  check('asked Graph mailboxSettings', providerCalls.at(-1)?.url.includes('mailboxSettings/timeZone'), true);
  const o1 = await userRow(o.id);
  check('calendar_provider = outlook', o1.calendar_provider, 'outlook');
  check('calendar_timezone = Europe/London', o1.calendar_timezone, 'Europe/London');

  console.log('\nTIMEZONE FAILURES NEVER BLOCK THE CONNECTION');
  graphReply = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
  const r4 = await connect({ client_id: 'Ai-NOTZ0001', provider: 'outlook', access_token: 'eyJ.no-scope' });
  check('403 from Graph -> still 200', r4.status, 200);
  check('timezone_source = unchanged', r4.json?.timezone_source, 'unchanged');
  const x1 = await userRow(x.id);
  check('still connected', x1.calendar_connected, true);
  check('active_timezone left at the default', x1.active_timezone, 'Europe/London');
  check('calendar_timezone left empty', x1.calendar_timezone, null);
  check('active_timezone_set_at not stamped', x1.active_timezone_set_at, null);

  googleReply = () => ({ status: 200, body: { timeZone: 'Mars/Olympus_Mons' } });
  const r5 = await connect({ client_id: 'Ai-NOTZ0001', provider: 'google', access_token: 'ya29.mars' });
  check('nonsense zone from provider -> still 200', r5.status, 200);
  check('nonsense zone ignored', (await userRow(x.id)).active_timezone, 'Europe/London');

  googleReply = () => ({ throw: 'network down' });
  const r6 = await connect({ client_id: 'Ai-NOTZ0001', provider: 'google', access_token: 'ya29.offline' });
  check('provider unreachable -> still 200', r6.status, 200);
  check('token still stored', crypto.decrypt((await userRow(x.id)).calendar_access_token_enc), 'ya29.offline');

  console.log('\nEARLIER TIMEZONE KEPT WHEN A LATER LOOKUP FAILS');
  const g3 = await connect({ client_id: 'Ai-GOOGLE01', provider: 'google', access_token: 'ya29.third' });
  check('200', g3.status, 200);
  const g4 = await userRow(g.id);
  check('calendar_timezone kept', g4.calendar_timezone, 'America/New_York');
  check('active_timezone kept', g4.active_timezone, 'America/New_York');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  server?.close();
  process.exit(1);
});
