/**
 * The Command Center team (migration 010, src/services/deskMembers.js).
 *
 * Boots the real app against a THROWAWAY database and DROPS its schema.
 *
 *   SB_URL=postgres://... node tests/desk-members.cjs
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.ADMIN_TOKENS = JSON.stringify([
  { actor: 'command-center', token: 'cc-write-token-0123456789', scope: 'write' },
  { actor: 'reporting', token: 'cc-read-token-0123456789', scope: 'read' },
]);
for (const k of ['AIRTABLE_API_KEY', 'TWILIO_ACCOUNT_SID', 'ANTHROPIC_API_KEY']) delete process.env[k];

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const db = require('../src/db/pool');
const deskMembers = require('../src/services/deskMembers');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const CC = { Authorization: 'Bearer cc-write-token-0123456789', 'Content-Type': 'application/json', 'X-Admin-Actor': 'owner@example.com' };
const READ = { Authorization: 'Bearer cc-read-token-0123456789', 'Content-Type': 'application/json' };
let base;
const call = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* keep text */ }
  return { status: res.status, body };
};
const post = (p, body, headers = CC) => call(p, { method: 'POST', headers, body: JSON.stringify(body) });

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql', '008_command_center.sql',
    '009_membership_and_feedback.sql', '010_desk_members.sql']) {
    await db.query(read('db', 'sql', f));
  }
  await db.query(read('db', 'sql', '010_desk_members.sql'));
  await db.query(read('db', 'sql', '010_desk_members_down.sql'));
  await db.query(read('db', 'sql', '010_desk_members.sql'));
  check('migration 010 applies twice, comes off, and goes back on', true, true);

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nEMAILS AND ROLES');
  check('email cleaned: trimmed and lower-case', deskMembers.cleanEmail('  Alice@Example.COM '), 'alice@example.com');
  for (const bad of ['', 'alice', 'a@b', 'a b@c.de', null]) {
    let code = null;
    try { deskMembers.cleanEmail(bad); } catch (e) { code = e.code; }
    check(`refused: ${JSON.stringify(bad)}`, code, 'invalid_email');
  }
  check('the database refuses an upper-case email too', await db.query(
    "INSERT INTO desk_members (email, role) VALUES ('Bad@Example.com', 'agent')").then(() => 'stored', (e) => e.code), '23514');

  console.log('\nTHROUGH THE ADMIN API');
  let r = await call('/admin/desk/members', { headers: READ });
  check('empty team', [r.status, r.body.count, r.body.roles], [200, 0, ['owner', 'agent', 'viewer']]);
  r = await post('/admin/desk/members', { email: 'Owner@Example.com', role: 'owner' });
  check('first owner added', [r.status, r.body.created, r.body.member.email, r.body.member.role], [200, true, 'owner@example.com', 'owner']);
  check('added_by is the person who did it', r.body.member.added_by, 'command-center:owner@example.com');
  r = await post('/admin/desk/members', { email: 'agent@example.com', role: 'agent' });
  check('agent added', [r.status, r.body.created], [200, true]);
  r = await post('/admin/desk/members', { email: 'agent@example.com', role: 'viewer' });
  check('role changed (not a second row)', [r.status, r.body.created, r.body.member.role], [200, false, 'viewer']);
  r = await post('/admin/desk/members', { email: 'x@example.com', role: 'boss' });
  check('unknown role -> 400', [r.status, r.body.code], [400, 'invalid_role']);
  r = await post('/admin/desk/members', { email: 'not-an-email', role: 'agent' });
  check('bad email -> 400', [r.status, r.body.code], [400, 'invalid_email']);
  r = await post('/admin/desk/members', { email: 'z@example.com', role: 'agent' }, READ);
  check('a read-only token cannot change the team', r.status, 403);

  r = await call('/admin/desk/members/lookup?email=OWNER@example.com', { headers: READ });
  check('lookup ignores case', r.body.member, { email: 'owner@example.com', role: 'owner' });
  r = await call('/admin/desk/members/lookup?email=stranger@example.com', { headers: READ });
  check('lookup: not on the team -> null', [r.status, r.body.member], [200, null]);
  r = await call('/admin/desk/members/lookup?email=', { headers: READ });
  check('lookup: no email -> null, not an error', [r.status, r.body.member], [200, null]);

  console.log('\nTHE LAST OWNER');
  r = await post('/admin/desk/members', { email: 'owner@example.com', role: 'agent' });
  check('the only owner cannot be demoted', [r.status, r.body.code], [409, 'last_owner']);
  r = await post('/admin/desk/members/remove', { email: 'owner@example.com' });
  check('the only owner cannot be removed', [r.status, r.body.code], [409, 'last_owner']);
  await post('/admin/desk/members', { email: 'second@example.com', role: 'owner' });
  const both = await Promise.all([
    post('/admin/desk/members', { email: 'owner@example.com', role: 'agent' }),
    post('/admin/desk/members', { email: 'second@example.com', role: 'agent' }),
  ]);
  check('two owners demoting each other at once: one wins, one owner is left',
    [both.map((x) => x.status).sort(), (await db.query("SELECT COUNT(*)::int n FROM desk_members WHERE role='owner'")).rows[0].n],
    [[200, 409], 1]);
  const owner = (await db.query("SELECT email FROM desk_members WHERE role='owner'")).rows[0].email;
  const other = owner === 'owner@example.com' ? 'second@example.com' : 'owner@example.com';
  r = await post('/admin/desk/members/remove', { email: other });
  check('a non-owner can be removed', [r.status, r.body.removed], [200, true]);
  r = await post('/admin/desk/members/remove', { email: other });
  check('removing again -> 404', [r.status, r.body.code], [404, 'not_found']);

  console.log('\nAUDIT');
  await new Promise((res) => setTimeout(res, 200));
  const actions = (await db.query("SELECT action, COUNT(*)::int n FROM admin_audit_logs WHERE action LIKE 'desk.%' GROUP BY 1 ORDER BY 1")).rows;
  check('team changes are in the audit log', actions.map((a) => a.action), ['desk.members.read', 'desk.members.remove', 'desk.members.save']);
  check('lookups are not (asked on every dashboard call)', actions.some((a) => a.action === 'desk.members.lookup'), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.pool.end();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FAILED:', err.message, '\n', err.stack);
  process.exit(1);
});
