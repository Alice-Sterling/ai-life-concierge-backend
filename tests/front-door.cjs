/**
 * The front door: status routing, the one-off welcome, the hand-off and the
 * two-hour auto-resume.
 *
 *   TEST_DATABASE_URL=postgres://... node tests/front-door.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 *
 * Twilio and Airtable are deliberately unconfigured: replies come back in the
 * TwiML, and Airtable is stubbed where a test needs it.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.STATUS_GATE_ENABLED = 'true';
process.env.PAYMENT_URL = 'https://pay.example.test/checkout';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'AIRTABLE_API_KEY', 'EMAIL_HOST']) {
  delete process.env[k];
}

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const airtable = require('../src/integrations/airtable');
const gateway = require('../src/services/gateway');
const handoff = require('../src/services/handoff');
const resumeJob = require('../src/jobs/humanModeResume');
const { createApp } = require('../src/app');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const realLookup = airtable.findUserRecord;
const stubAirtable = (record) => { airtable.findUserRecord = async () => record; };
const unstubAirtable = () => { airtable.findUserRecord = realLookup; };

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql', '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql']) {
    await db.query(read('db', 'sql', f));
  }

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (from, body) => {
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, Body: body }).toString(),
    });
    return res.text();
  };
  const addUser = async (n, phase, extra = {}) => {
    const { rows } = await db.query(
      `INSERT INTO users (phone_number, first_name, client_id, short_id, onboarding_phase, welcome_message_sent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [`whatsapp:+4477009001${n}`, `User${n}`, `Ai-TEST${n}`, `AI-S${n}`, phase, extra.welcomed ?? false]);
    return rows[0];
  };
  const phaseOf = async (id) => (await db.query('SELECT onboarding_phase FROM users WHERE id = $1', [id])).rows[0].onboarding_phase;

  console.log('\nUNKNOWN NUMBER');
  let r = await send('whatsapp:+447700900199', 'Hello?');
  check('gets the invitation-only message', r.includes('by invitation'), true);
  check('with the waitlist link', r.includes('ailifeconcierge.co.uk'), true);
  check('no account is created', (await db.query(`SELECT 1 FROM users WHERE phone_number = 'whatsapp:+447700900199'`)).rows.length, 0);
  r = await send('whatsapp:+447700900199', 'Anyone?');
  check('a second message inside 6h gets silence, not a repeat', r.includes('by invitation'), false);

  console.log('\nSIGNED UP ON THE WEBSITE (in Airtable, not in Postgres)');
  stubAirtable({ id: 'rec1', fields: { 'First Name': 'Maya', 'Client ID': 'Ai-WEB001', Status: 'Approved' } });
  r = await send('whatsapp:+447700900198', 'Hi');
  const adopted = (await db.query(`SELECT * FROM users WHERE phone_number = 'whatsapp:+447700900198'`)).rows[0];
  check('their account is created from Airtable', adopted?.first_name, 'Maya');
  check('keeping the Airtable client id', adopted?.client_id, 'Ai-WEB001');
  check('and the Airtable status', adopted?.onboarding_phase, 'Approved');
  check('they get the invitation, by name', r.includes('Welcome to Ai Life Concierge, Maya'), true);
  check('with their personal onboarding link', r.includes('client_id='), true);
  unstubAirtable();

  console.log('\nSTATUS TEMPLATES');
  const wait = await addUser(1, 'Waitlist');
  r = await send(wait.phone_number, 'Hello');
  check('Waitlist: told they are on the waitlist', r.includes('Founding Member waitlist'), true);
  r = await send(wait.phone_number, 'Hello again');
  check('Waitlist: not told twice in 6h', r.includes('waitlist'), false);
  const logged = await db.query('SELECT ai_response, metadata FROM conversations WHERE user_id = $1 ORDER BY timestamp', [wait.id]);
  check('both messages are in their history', logged.rows.length, 2);
  check('the suppressed one is marked', logged.rows[1].metadata.suppressed, true);

  const denied = await addUser(2, 'Denied');
  r = await send(denied.phone_number, 'Hi');
  check('Denied: the polite no', r.includes('unable to offer you membership'), true);
  check('Denied: "Hello" only once (typo in the brief fixed)', (r.match(/Hello/g) || []).length, 1);

  const approved = await addUser(3, 'Approved');
  r = await send(approved.phone_number, 'Hi');
  check('Approved: onboarding link with their id', r.includes('client_id=AI-S3'), true);

  const onboarded = await addUser(4, 'Onboarded');
  r = await send(onboarded.phone_number, 'Hi');
  check('Onboarded: one final step', r.includes('one final step'), true);
  check('Onboarded: with the payment link', r.includes('pay.example.test'), true);
  check('payment link carries client_reference_id for Stripe', r.includes('pay.example.test/checkout?client_reference_id='), true);

  console.log('\nINACTIVE');
  const inactive = await addUser(5, 'Inactive');
  r = await send(inactive.phone_number, 'Can you book dinner?');
  check('Inactive: told the membership is inactive', r.includes('currently inactive'), true);
  r = await send(inactive.phone_number, 'Hi, I need help with my membership, please.');
  check('the quick reply is acknowledged', r.includes('team will be in touch'), true);
  const helpTask = await db.query('SELECT priority, requires_human FROM tasks WHERE user_id = $1', [inactive.id]);
  check('and raises a desk task', helpTask.rows.length, 1);
  check('marked high priority', helpTask.rows[0]?.priority, 'high');

  console.log('\nSTATUS CHANGED IN AIRTABLE');
  const moving = await addUser(6, 'Waitlist');
  stubAirtable({ id: 'rec6', fields: { Status: 'On boarded' } });
  r = await send(moving.phone_number, 'Hi');
  check('"On boarded" in Airtable is read as Onboarded', await phaseOf(moving.id), 'Onboarded');
  check('and the reply follows the new status', r.includes('one final step'), true);
  unstubAirtable();

  console.log('\nACTIVE: THE WELCOME, ONCE');
  const active = await addUser(7, 'Active');
  const first = await gateway.admit(active, { phoneNumber: active.phone_number, incomingText: 'Hi' });
  check('a plain hello gets the welcome and stops there', first.halt, true);
  check('it is the welcome', first.reply?.text.includes('trial is now active'), true);
  const after = (await db.query('SELECT welcome_message_sent, onboarding_status, onboarding_step FROM users WHERE id = $1', [active.id])).rows[0];
  check('the flag is set', after.welcome_message_sent, true);
  check('the old WhatsApp interview is marked done', after.onboarding_status, 'complete');
  check('at step 8', after.onboarding_step, 8);
  const second = await gateway.admit({ ...active, ...after }, { phoneNumber: active.phone_number, incomingText: 'Hi' });
  check('the next message goes to Alice', second.halt, false);

  const keen = await addUser(8, 'Active');
  const req = await gateway.admit(keen, { phoneNumber: keen.phone_number, incomingText: 'Book me dinner Friday in Mayfair' });
  check('a real first request still reaches Alice', req.halt, false);
  check('with the welcome claimed on the way', (await db.query('SELECT welcome_message_sent FROM users WHERE id = $1', [keen.id])).rows[0].welcome_message_sent, true);

  console.log('\nHAND-OFF');
  const t = handoff.extractTags('Excellent choice.\n[AI_SUMMARY: Date Night - Sam - Hakkasan, Fri 8pm, 2 pax]\n[TRIGGER_HUMAN_MODE]');
  check('the tag is detected', t.triggered, true);
  check('the summary is read', t.summary, 'Date Night - Sam - Hakkasan, Fri 8pm, 2 pax');
  check('the client never sees either tag', t.text, 'Excellent choice.');
  check('an ordinary reply is left alone', handoff.extractTags('See you Friday.').triggered, false);

  const client = await addUser(9, 'Active', { welcomed: true });
  const task = await handoff.toHuman(client, { summary: 'Date Night - User9 - Hakkasan Fri 8pm', category: 'date_night', sourceMessage: 'The first one please' });
  const handed = (await db.query('SELECT conversation_mode, conversation_mode_changed_at FROM users WHERE id = $1', [client.id])).rows[0];
  check('the client is switched to human mode', handed.conversation_mode, 'human');
  check('the clock starts', handed.conversation_mode_changed_at !== null, true);
  check('the desk gets a date_night task', task.category, 'date_night');
  check('flagged Requires Human', task.requires_human, true);

  console.log('\nAUTO-RESUME AFTER TWO QUIET HOURS');
  let sweep = await resumeJob.runSweep();
  check('a fresh hand-off is left alone', sweep.resumed, 0);

  await db.query(`UPDATE users SET conversation_mode_changed_at = NOW() - interval '3 hours' WHERE id = $1`, [client.id]);
  await db.query(`INSERT INTO conversations (user_id, message_body, timestamp) VALUES ($1, 'still there?', NOW() - interval '30 minutes')`, [client.id]);
  sweep = await resumeJob.runSweep();
  check('a client still talking to the desk is left alone', sweep.resumed, 0);

  await db.query(`UPDATE conversations SET timestamp = NOW() - interval '3 hours' WHERE user_id = $1`, [client.id]);
  sweep = await resumeJob.runSweep();
  check('two quiet hours: handed back', sweep.resumed, 1);
  const back = (await db.query('SELECT conversation_mode FROM users WHERE id = $1', [client.id])).rows[0];
  check('Alice has them again', back.conversation_mode, 'ai');

  server.close();
  await db.pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack); process.exit(1); });
