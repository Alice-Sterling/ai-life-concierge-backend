/**
 * The date-night loop, end to end.
 *
 *   TEST_DATABASE_URL=postgres://... node tests/date-night.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const dateNight = require('../src/services/dateNight');
const { createApp } = require('../src/app');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const days = (a, b) => Math.round((new Date(a) - new Date(b)) / 86_400_000);

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql']) {
    await db.query(read('db', 'sql', f));
  }

  const prefs = { date_night: { neighborhood: 'Mayfair', budget: '£££', cuisines: ['Chinese'], dietary_restrictions: ['None'] } };
  const { rows } = await db.query(
    `INSERT INTO users (first_name, phone_number, preferences) VALUES ('Sam','+447700900600',$1::jsonb) RETURNING id`,
    [JSON.stringify(prefs)]);
  const userId = rows[0].id;

  console.log('\nINTAKE SETS A SCHEDULE');
  const sched = await dateNight.scheduleAfterIntake(userId, undefined);
  check('cadence defaults to fortnightly', sched.date_night_cadence, 14);
  check('first one is due in 14 days', days(sched.next_date_due_at, new Date()), 14);

  const weekly = await dateNight.scheduleAfterIntake(userId, 7);
  check('re-running intake updates the cadence', weekly.date_night_cadence, 7);
  check('but keeps the planned date', days(weekly.next_date_due_at, sched.next_date_due_at), 0);
  check('nonsense cadence is clamped, not stored', dateNight.normaliseCadence(9999), 90);

  console.log('\nNOT DUE YET: NOTHING HAPPENS');
  let r = await dateNight.runDueSweep();
  check('no task raised', r.created, 0);

  console.log('\nDUE: THE OPERATOR GETS A BRIEF');
  await db.query(`UPDATE users SET next_date_due_at = NOW() - interval '1 hour' WHERE id = $1`, [userId]);
  r = await dateNight.runDueSweep();
  check('one task raised', r.created, 1);
  const t = await db.query(`SELECT * FROM tasks WHERE user_id = $1 AND category = 'date_night'`, [userId]);
  check('it is a date_night task', t.rows[0].category, 'date_night');
  check('assigned to the concierge desk', t.rows[0].assigned_to, 'assist@ailifeconcierge.co.uk');
  check('the brief carries the area', t.rows[0].ai_summary.includes('Mayfair'), true);
  check('and the vault pick (Park Chinois, Mayfair)', t.rows[0].ai_summary.includes('Park Chinois'), true);

  const ev = await db.query(`SELECT COUNT(*)::int n FROM events WHERE event_name = 'date_night_due'`);
  check('a date_night_due event is recorded', ev.rows[0].n, 1);
  const al = await db.query(`SELECT status FROM automation_logs WHERE automation_type = 'date_night_cron'`);
  check('the run is in the audit log', al.rows[0]?.status, 'success');

  console.log('\nHOURLY RE-RUNS DO NOT STACK DUPLICATES');
  r = await dateNight.runDueSweep();
  check('skipped because a task is already open', r.skipped, 1);
  const count = await db.query(`SELECT COUNT(*)::int n FROM tasks WHERE category = 'date_night'`);
  check('still exactly one task', count.rows[0].n, 1);

  console.log('\nAN AREA THE VAULT DOES NOT COVER IS FLAGGED, NOT FAKED');
  const brief = dateNight.buildBrief({ first_name: 'X', date_night_cadence: 14 }, { neighborhood: 'Shoreditch' }, []);
  check('the gap is called out', brief.includes('No vetted venues in the vault for "Shoreditch"'), true);

  console.log('\nCLOSING THE TASK SCHEDULES THE NEXT ONE');
  const server = createApp().listen(0);
  await new Promise((res) => server.once('listening', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  check('bad status is refused', (await post(`/admin/tasks/${t.rows[0].task_id}/status`, { status: 'done-ish' })).status, 400);
  check('unknown task is a 404', (await post('/admin/tasks/00000000-0000-0000-0000-000000000000/status', { status: 'completed' })).status, 404);

  const closed = await post(`/admin/tasks/${t.rows[0].task_id}/status`, { status: 'completed' });
  check('operator marks it completed', closed.status, 200);

  const after = await db.query('SELECT last_date_curated_at, next_date_due_at FROM users WHERE id = $1', [userId]);
  check('the curation is recorded', after.rows[0].last_date_curated_at !== null, true);
  check('the next one is due a week out (cadence 7)', days(after.rows[0].next_date_due_at, new Date()), 7);

  r = await dateNight.runDueSweep();
  check('nothing is due straight after', r.due, 0);

  server.close();
  await db.pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack); process.exit(1); });
