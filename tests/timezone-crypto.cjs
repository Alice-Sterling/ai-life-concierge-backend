/**
 * Tests for travel-aware timezone and encrypted credential storage.
 *
 *   TEST_DATABASE_URL=postgres://... node tests/timezone-crypto.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes of hex, test only
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const db = require('../src/db/pool');
const crypto = require('../src/lib/crypto');
const timezone = require('../src/services/timezone');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let server, base, pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};
const AUTH = { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' };

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  await db.query(read('db', 'sql', '001a_prepare.sql'));
  await db.query(read('db', 'sql', '001b_finalize.sql'));
  await db.query(read('db', 'sql', '003_timezone_and_tokens.sql'));

  const { rows } = await db.query(
    `INSERT INTO users (first_name, phone_number) VALUES ('Traveller','+447700900321') RETURNING id, active_timezone`);
  const userId = rows[0].id;

  console.log('\nENCRYPTION');
  const secret = 'ya29.a0AfB_byC-REAL-LOOKING-OAUTH-TOKEN-xyz123';
  const enc = crypto.encrypt(secret);
  check('round-trips correctly', crypto.decrypt(enc), secret);
  check('ciphertext is a Buffer', Buffer.isBuffer(enc), true);
  check('plaintext is not visible in the bytes', enc.toString('utf8').includes('ya29'), false);
  const enc2 = crypto.encrypt(secret);
  check('same input gives different ciphertext (fresh IV)', enc.equals(enc2), false);
  check('but both decrypt to the same value', crypto.decrypt(enc2), secret);

  // GCM must reject tampering rather than return plausible rubbish.
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 0xff;
  let threw = false;
  try { crypto.decrypt(tampered); } catch { threw = true; }
  check('tampered ciphertext is rejected', threw, true);

  console.log('\nENCRYPTED STORAGE ROUND TRIP');
  await db.query(
    `UPDATE users SET calendar_access_token_enc = $2, calendar_refresh_token_enc = $3,
                      calendar_token_updated_at = NOW() WHERE id = $1`,
    [userId, crypto.encrypt(secret), crypto.encrypt('refresh-token-abc')]);
  const stored = await db.query('SELECT calendar_access_token_enc, calendar_refresh_token_enc FROM users WHERE id = $1', [userId]);
  check('access token decrypts from the database', crypto.decrypt(stored.rows[0].calendar_access_token_enc), secret);
  check('refresh token decrypts from the database', crypto.decrypt(stored.rows[0].calendar_refresh_token_enc), 'refresh-token-abc');
  // Anyone reading the table without the key must see nothing useful.
  check('raw column reveals no plaintext',
    stored.rows[0].calendar_access_token_enc.toString('utf8').includes('ya29'), false);

  console.log('\nTIMEZONE BASICS');
  check('defaults to Europe/London', rows[0].active_timezone, 'Europe/London');
  check('Asia/Dubai is valid', timezone.isValidTimezone('Asia/Dubai'), true);
  check('Not/AZone is rejected', timezone.isValidTimezone('Not/AZone'), false);
  check('a UTC offset is rejected', timezone.isValidTimezone('+04:00'), false);

  const london = timezone.formatNowFor('Europe/London');
  const dubai = timezone.formatNowFor('Asia/Dubai');
  check('London and Dubai give different local times', london.localTime === dubai.localTime, false);
  console.log(`      London: ${london.localTime} (${london.utcOffset})`);
  console.log(`      Dubai : ${dubai.localTime} (${dubai.utcOffset})`);

  console.log('\nAGENT TOOL (what Alice calls when a client travels)');
  const applied = await timezone.setForUser(userId, 'Asia/Dubai');
  check('the tool sets the timezone', applied.timezone, 'Asia/Dubai');
  const after = await db.query('SELECT active_timezone, active_timezone_set_at FROM users WHERE id = $1', [userId]);
  check('it is persisted', after.rows[0].active_timezone, 'Asia/Dubai');
  check('the change is timestamped', after.rows[0].active_timezone_set_at !== null, true);
  const ev = await db.query("SELECT COUNT(*)::int n FROM events WHERE event_name = 'timezone_changed'");
  check('a timezone_changed event is recorded', ev.rows[0].n, 1);

  let rejected = false;
  try { await timezone.setForUser(userId, 'Mars/Olympus'); } catch { rejected = true; }
  check('a nonsense timezone is refused', rejected, true);
  const unchanged = await db.query('SELECT active_timezone FROM users WHERE id = $1', [userId]);
  check('and the old value is left alone', unchanged.rows[0].active_timezone, 'Asia/Dubai');

  console.log('\nDATABASE CONSTRAINT');
  let dbRejected = false;
  try { await db.query('UPDATE users SET active_timezone = $2 WHERE id = $1', [userId, 'Nope/Nope']); }
  catch { dbRejected = true; }
  check('the database rejects it too', dbRejected, true);

  console.log('\nADMIN ENDPOINT');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const call = async (p, opts) => {
    const res = await fetch(base + p, opts);
    const raw = await res.text();
    let body = raw; try { body = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, body };
  };

  check('unauthenticated is rejected',
    (await call(`/admin/users/${userId}/timezone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const set = await call(`/admin/users/${userId}/timezone`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ active_timezone: 'America/New_York' }) });
  check('operator can set it', set.status, 200);
  check('and it comes back', set.body?.timezone, 'America/New_York');

  const bad = await call(`/admin/users/${userId}/timezone`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ active_timezone: 'Nowhere/Nothing' }) });
  check('a bad value returns 400', bad.status, 400);

  const listed = await call('/admin/users', { headers: AUTH });
  check('admin list includes the timezone',
    listed.body?.users?.find((u) => u.id === userId)?.active_timezone, 'America/New_York');

  server.close();
  await db.pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nFAILED:', e.message, '\n', e.stack);
  server?.close();
  process.exit(1);
});
