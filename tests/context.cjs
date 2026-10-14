/**
 * Step C prompt context (flattened profile, open tasks, calendar status) and
 * the narrowed trial-nudge answer.
 *
 *   SB_URL=postgres://... node tests/context.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'AIRTABLE_API_KEY']) delete process.env[k];

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const ctx = require('../src/services/promptContext');
const { isTrialNudgeAnswer } = require('../src/routes/webhook');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

(async () => {
  console.log('\nFLATTENED PROFILE');
  const full = ctx.profileBlock({
    active_automations: ['date_night', 'logistics'],
    preferences: {
      lifestyle_preferences: { partner_name: 'Sarah', home_city: 'London', work_city: 'Paris', favorite_cuisine: 'Sushi, Italian' },
      date_night: { dietary_restrictions: ['Dairy-free', 'Gluten-free'], neighborhood: 'Mayfair', budget: '' },
    },
  });
  check('has the heading', full.includes('### USER PROFILE CONTEXT'), true);
  check('automations as words', full.includes('Active Automations: Date Night, Logistics'), true);
  check('partner', full.includes('Partner Name: Sarah'), true);
  check('home city', full.includes('Home City: London'), true);
  check('work city', full.includes('Work City: Paris'), true);
  check('dietary list joined', full.includes('Dietary Restrictions: Dairy-free, Gluten-free'), true);
  check('cuisine', full.includes('Favorite Cuisine: Sushi, Italian'), true);
  check('area from date-night intake', full.includes('Preferred Area: Mayfair'), true);
  check('empty budget left out', full.includes('Budget'), false);
  check('no raw JSON or null', /[{}]|null|undefined/.test(full), false);
  check('nothing known -> no block at all', ctx.profileBlock({ preferences: { date_night: { budget: ' ' } } }), '');
  check('preferences stored as a JSON string still read',
    ctx.profileBlock({ preferences: JSON.stringify({ partner_name: 'Alex' }) }).includes('Partner Name: Alex'), true);

  console.log('\nCALENDAR STATUS');
  check('connected -> the brief\'s rule',
    ctx.calendarBlock({ calendar_connected: true, calendar_provider: 'outlook' })
      .includes('CONNECTED (Provider: Outlook)') , true);
  check('says never reconnect', ctx.calendarBlock({ calendar_connected: true }).includes('Never ask them to reconnect'), true);
  check('not connected -> nothing', ctx.calendarBlock({ calendar_connected: false, calendar_provider: 'google' }), '');

  console.log('\nOPEN TASKS');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql']) {
    await db.query(read('db', 'sql', f));
  }
  const { rows: [u] } = await db.query(
    "INSERT INTO users (first_name, phone_number) VALUES ('Tasky', '+447700900801') RETURNING id");
  check('no tasks -> nothing', await ctx.tasksBlock(u.id), '');
  const add = (status, summary) => db.query(
    `INSERT INTO tasks (user_id, ai_summary, category, status, requires_human)
     VALUES ($1, $2, 'date_night', $3, true)`, [u.id, summary, status]);
  await add('in_progress', 'Book Gymkhana for Friday 19:30, 2 guests.');
  await add('completed', 'Old finished thing.');
  await add('new', 'Find a florist in Chelsea\nfor Saturday.');
  const block = await ctx.tasksBlock(u.id);
  check('lists open tasks', block.includes('Book Gymkhana') && block.includes('florist in Chelsea'), true);
  check('leaves out completed ones', block.includes('Old finished thing'), false);
  check('one line per task', block.includes('Chelsea for Saturday'), true);
  check('tells Alice not to duplicate', block.includes('Do not start these again'), true);

  console.log('\nTRIAL NUDGE ANSWER');
  const nudged = { onboarding_phase: 'Approved', last_nudge_at: new Date(Date.now() - 3 * 3600e3) };
  check('"YES" after the nudge -> trial', isTrialNudgeAnswer(nudged, 'YES'), true);
  check('"yes please" after the nudge -> trial', isTrialNudgeAnswer(nudged, 'yes please'), true);
  check('"yes, book it for 8pm" -> Alice', isTrialNudgeAnswer(nudged, 'yes, book it for 8pm'), false);
  check('"what is in the trial?" -> Alice', isTrialNudgeAnswer(nudged, 'what is in the trial?'), false);
  check('"yes" with no nudge -> Alice', isTrialNudgeAnswer({ onboarding_phase: 'Approved' }, 'yes'), false);
  check('"yes" from an Active member -> Alice',
    isTrialNudgeAnswer({ onboarding_phase: 'Active', last_nudge_at: new Date() }, 'yes'), false);
  check('"yes" a week after the nudge -> Alice',
    isTrialNudgeAnswer({ onboarding_phase: 'Approved', last_nudge_at: new Date(Date.now() - 7 * 86400e3) }, 'yes'), false);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
