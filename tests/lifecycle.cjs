/**
 * Lifecycle messages: Stripe -> Active, Airtable status triggers, the 24h
 * onboarding reminder, the 48h handshake ping, the 4h proposal nudge, the
 * date-night ping and the answers to those pings.
 *
 *   SB_URL=postgres://... node tests/lifecycle.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 * Twilio is stubbed: nothing is ever sent.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_lifecycle';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'AIRTABLE_API_KEY',
  'EMAIL_HOST', 'STRIPE_WEBHOOK_SECRET', 'STATUS_GATE_ENABLED']) {
  delete process.env[k];
}

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const twilio = require('../src/integrations/twilio');
const { config } = require('../src/config');
const lifecycle = require('../src/services/lifecycle');
const dateNight = require('../src/services/dateNight');
const proactiveReplies = require('../src/services/proactiveReplies');
const lifecycleJob = require('../src/jobs/lifecycle');
const airtable = require('../src/integrations/airtable');
const gateway = require('../src/services/gateway');
const { createApp } = require('../src/app');

// ---- Twilio stub: records instead of sending
const sent = [];
twilio.isConfigured = () => true;
twilio.sendTemplate = async (to, sid, variables) => { sent.push({ kind: 'template', to, sid, variables }); return true; };
twilio.sendWhatsApp = async (to, body) => { sent.push({ kind: 'text', to, body }); return true; };
const lastSent = () => sent[sent.length - 1] || {};

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const AUTH = { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' };

let n = 0;
async function makeUser(fields = {}) {
  n += 1;
  const f = {
    first_name: `User${n}`, phone_number: `whatsapp:+4477009006${String(n).padStart(2, '0')}`,
    client_id: `Ai-LIFE${String(n).padStart(4, '0')}`, onboarding_phase: 'Waitlist', ...fields,
  };
  const cols = Object.keys(f);
  const { rows } = await db.query(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => (f[c] !== null && typeof f[c] === 'object' && !(f[c] instanceof Date) ? JSON.stringify(f[c]) : f[c])));
  return rows[0];
}
const wrote = (userId, hoursAgo, aiResponse = 'ok') => db.query(
  `INSERT INTO conversations (user_id, message_body, ai_response, timestamp)
   VALUES ($1, 'hi', $2, NOW() - make_interval(mins => $3::int))`, [userId, aiResponse, Math.round(hoursAgo * 60)]);
const pastSend = (userId, key, hoursAgo) => db.query(
  `INSERT INTO outbound_messages (user_id, body, status, template_key, created_at)
   VALUES ($1, 'x', 'sent', $2, NOW() - make_interval(mins => $3::int))`, [userId, key, Math.round(hoursAgo * 60)]);
const fresh = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const countSends = async (id, key) => (await db.query(
  'SELECT count(*)::int AS n FROM outbound_messages WHERE user_id = $1 AND template_key = $2', [id, key])).rows[0].n;

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql', '007_lifecycle.sql']) {
    await db.query(read('db', 'sql', f));
  }

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, headers = AUTH) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  console.log('\nJOB SWITCHES');
  check('everything off -> the job does nothing', JSON.stringify(await lifecycleJob.runOnce()), '{}');

  console.log('\nAIRTABLE STATUS TRIGGER');
  check('no id -> 400', (await post('/admin/users/status-changed', { status: 'Approved' })).status, 400);
  const a = await makeUser();
  check('bad status -> 400', (await post('/admin/users/status-changed', { client_id: a.client_id, status: 'Banana' })).status, 400);
  check('unknown client -> 404', (await post('/admin/users/status-changed', { client_id: 'Ai-NOBODY', status: 'Approved' })).status, 404);

  let r = await post('/admin/users/status-changed', { client_id: a.client_id, status: 'Approved' });
  check('Approved, no template yet, never wrote -> not sent', r.json?.via, 'no_template_outside_window');
  check('status still copied to Postgres', (await fresh(a.id)).onboarding_phase, 'Approved');

  config.templates.status_approved = 'HXapproved';
  r = await post('/admin/users/status-changed', { client_id: a.client_id, status: 'approved' });
  check('with the template -> sent via template', r.json?.via, 'template');
  check('template SID used', lastSent().sid, 'HXapproved');
  check('{{1}} = first name', lastSent().variables?.[1], a.first_name);
  check('{{2}} = client id (CTA link)', lastSent().variables?.[2], a.client_id);
  r = await post('/admin/users/status-changed', { client_id: a.client_id, status: 'Approved' });
  check('repeat within 24h -> suppressed', r.json?.via, 'suppressed_repeat');

  const d = await makeUser();
  await wrote(d.id, 1);
  r = await post('/admin/users/status-changed', { phone: d.phone_number.replace('whatsapp:', ''), status: 'Denied' });
  check('found by phone, in window, no template -> plain text', r.json?.via, 'text');
  check('denied wording', /unable to offer you membership/.test(lastSent().body || ''), true);

  console.log('\nACTIVATION (Airtable -> Active)');
  const act = await makeUser({ onboarding_phase: 'Onboarded' });
  r = await post('/admin/users/status-changed', { client_id: act.client_id, status: 'Active' });
  let row = await fresh(act.id);
  check('status Active', row.onboarding_phase, 'Active');
  check('activated_at stamped', row.activated_at instanceof Date, true);
  check('no welcome template, outside window -> deferred', r.json?.via, 'deferred_to_next_message');
  check('welcome claim released for the front door', row.welcome_message_sent, false);

  config.templates.active_welcome = 'HXwelcome';
  r = await post('/admin/users/status-changed', { client_id: act.client_id, status: 'Active' });
  row = await fresh(act.id);
  check('with the template -> welcome sent', r.json?.via, 'sent');
  check('welcome flag set', row.welcome_message_sent, true);
  r = await post('/admin/users/status-changed', { client_id: act.client_id, status: 'Active' });
  check('third time -> already sent, nothing new', r.json?.via, 'already_sent');

  console.log('\nSTRIPE CHECKOUT');
  const s = await makeUser({ onboarding_phase: 'Onboarded' });
  const checkout = (ref) => fetch(`${base}/stripe-webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: ref } } }),
  });
  await checkout(s.client_id);
  row = await fresh(s.id);
  check('switch off: tier upgraded', row.tier, 'pro');
  check('switch off: status unchanged', row.onboarding_phase, 'Onboarded');
  config.lifecycle.stripeActivates = true;
  await checkout(s.client_id);
  row = await fresh(s.id);
  check('switch on: found by client_reference_id, status Active', row.onboarding_phase, 'Active');
  check('switch on: welcome sent', row.welcome_message_sent, true);
  check('switch on: activated_at stamped', row.activated_at instanceof Date, true);

  console.log('\n24H ONBOARDING REMINDER');
  config.templates.onboarding_reminder = 'HXreminder';
  const late = await makeUser({ onboarding_phase: 'Approved' });
  const early = await makeUser({ onboarding_phase: 'Approved' });
  const done = await makeUser({ onboarding_phase: 'Onboarded' });
  await pastSend(late.id, 'status_approved', 25);
  await pastSend(early.id, 'status_approved', 2);
  await pastSend(done.id, 'status_approved', 30);
  let res = await lifecycle.runOnboardingReminders();
  check('only the client invited >24h ago and still Approved', res.sent, 1);
  check('to the right client', await countSends(late.id, 'onboarding_reminder'), 1);
  check('reminder sent as template', lastSent().sid, 'HXreminder');
  res = await lifecycle.runOnboardingReminders();
  check('second run -> nobody (once per invitation)', res.sent, 0);
  check('reminder logged as an event', (await db.query(
    "SELECT count(*)::int AS n FROM events WHERE event_name = 'onboarding_reminder_sent' AND user_id = $1", [late.id])).rows[0].n, 1);

  console.log('\n48H HANDSHAKE PING');
  const quiet = await makeUser({ onboarding_phase: 'Active', activated_at: new Date(Date.now() - 49 * 3600e3) });
  const chatty = await makeUser({ onboarding_phase: 'Active', activated_at: new Date(Date.now() - 49 * 3600e3) });
  await wrote(chatty.id, 2);
  const old = await makeUser({ onboarding_phase: 'Active', activated_at: new Date(Date.now() - 10 * 86400e3) });
  const young = await makeUser({ onboarding_phase: 'Active', activated_at: new Date(Date.now() - 20 * 3600e3) });
  res = await lifecycle.runHandshakePings();
  check('no template yet -> skipped, not faked', res.sent, 0);
  config.templates.handshake_ping = 'HXhandshake';
  res = await lifecycle.runHandshakePings();
  check('only the quiet client activated 48h ago', res.sent, 1);
  check('to the right client', await countSends(quiet.id, 'handshake_ping'), 1);
  check('active in last 24h -> left alone', await countSends(chatty.id, 'handshake_ping'), 0);
  check('activated 10 days ago -> never', await countSends(old.id, 'handshake_ping'), 0);
  check('activated 20h ago -> not yet', await countSends(young.id, 'handshake_ping'), 0);
  check('second run -> nobody', (await lifecycle.runHandshakePings()).sent, 0);

  console.log('\nANSWER: READY');
  let ans = await proactiveReplies.handle(await fresh(quiet.id), 'Ready');
  check('Ready after the ping -> briefing note for Alice', /week ahead/.test(ans.contextNote || ''), true);
  check('no canned reply', ans.reply, undefined);
  check('handshake completed event', (await db.query(
    "SELECT count(*)::int AS n FROM events WHERE event_name = 'post_activation_handshake_completed' AND user_id = $1",
    [quiet.id])).rows[0].n, 1);
  ans = await proactiveReplies.handle(await fresh(old.id), 'Ready');
  check('Ready with no ping -> ordinary message', JSON.stringify(ans), '{}');

  console.log('\n4H PROPOSAL NUDGE');
  const opts = 'Two options for Friday:\n1. Dinner at Gymkhana, 19:30\n2. Jazz at Ronnie Scott\'s, 20:00\nWhich do you prefer?';
  const waiting = await makeUser({ onboarding_phase: 'Active' });
  await wrote(waiting.id, 5, opts);
  const fresh2h = await makeUser({ onboarding_phase: 'Active' });
  await wrote(fresh2h.id, 2, opts);
  const noOpts = await makeUser({ onboarding_phase: 'Active' });
  await wrote(noOpts.id, 5, 'Lovely, I will remember that you prefer window seats.');
  const human = await makeUser({ onboarding_phase: 'Active', conversation_mode: 'human' });
  await wrote(human.id, 5, opts);
  const answered = await makeUser({ onboarding_phase: 'Active' });
  await wrote(answered.id, 6, opts);
  await wrote(answered.id, 5, 'Booked, see you there.');
  res = await lifecycle.runProposalNudges();
  check('exactly one nudge', res.sent, 1);
  check('to the client who left options unanswered for 4h+', await countSends(waiting.id, 'proposal_nudge'), 1);
  check('nudge is plain text (inside the window)', lastSent().kind, 'text');
  check('nudge wording', /keeping this warm/.test(lastSent().body || ''), true);
  check('second run -> no repeat', (await lifecycle.runProposalNudges()).sent, 0);

  console.log('\nDATE-NIGHT PING');
  const London9 = new Date('2026-10-14T08:30:00Z'); // 09:30 in London (BST)
  const London13 = new Date('2026-10-14T12:30:00Z');
  const dn = await makeUser({
    onboarding_phase: 'Active', date_night_cadence: 14, active_timezone: 'Europe/London',
    next_date_due_at: new Date(Date.now() - 3600e3), preferences: { date_night: { partner_name: 'Sam' } },
  });
  res = await dateNight.runDueSweep(undefined, { now: London13 });
  check('switch off -> desk task, as before', res.created, 1);
  await db.query("UPDATE tasks SET status = 'completed' WHERE user_id = $1", [dn.id]);

  config.lifecycle.dateNightPing = true;
  config.templates.datenight_ping = 'HXdatenight';
  res = await dateNight.runDueSweep(undefined, { now: London13 });
  check('ping mode, 13:30 local -> waits for the morning', res.pinged, 0);
  res = await dateNight.runDueSweep(undefined, { now: London9 });
  check('ping mode, 09:30 local -> pinged', res.pinged, 1);
  check('template SID', lastSent().sid, 'HXdatenight');
  check('{{2}} cadence word', lastSent().variables?.[2], 'fortnightly');
  check('{{3}} partner name', lastSent().variables?.[3], 'Sam');
  row = await fresh(dn.id);
  const days = (new Date(row.next_date_due_at) - Date.now()) / 86400e3;
  check('cycle moved on 14 days', days > 13.9 && days < 14.1, true);
  check('no desk task in ping mode', (await db.query(
    "SELECT count(*)::int AS n FROM tasks WHERE user_id = $1 AND status <> 'completed'", [dn.id])).rows[0].n, 0);

  console.log('\nANSWER: REVIEW / SKIP');
  const before = sent.length;
  ans = await proactiveReplies.handle(row, 'Review Options');
  check('Review -> curation note for Alice', /2 contrasting/.test(ans.contextNote || ''), true);
  check('note names the partner', /Sam/.test(ans.contextNote || ''), true);
  check('"one moment" sent first', sent.length === before + 1 && /Give me just a moment/.test(lastSent().body), true);
  await db.query('UPDATE users SET next_date_due_at = NOW() WHERE id = $1', [dn.id]);
  ans = await proactiveReplies.handle(row, 'Skip This Week');
  check('Skip -> canned reply, Alice not called', /skip this one/.test(ans.reply || ''), true);
  const skipDays = (new Date((await fresh(dn.id)).next_date_due_at) - Date.now()) / 86400e3;
  check('Skip -> next date one cadence out', skipDays > 13.9 && skipDays < 14.1, true);
  const other = await makeUser({ onboarding_phase: 'Active' });
  check('"skip the starter" with no ping -> ordinary message',
    JSON.stringify(await proactiveReplies.handle(other, 'skip the starter please')), '{}');

  console.log('\nPHONE FORMATS');
  check('UK national -> international', airtable.phoneDigitVariants('07700 900123')[0], '447700900123');
  check('whatsapp: prefix and + dropped', airtable.phoneDigitVariants('whatsapp:+447700900123')[0], '447700900123');
  check('UK number also tried as 07…', airtable.phoneDigitVariants('+44 7700-900123')[1], '07700900123');
  check('00 prefix', airtable.phoneDigitVariants('0044 7700 900123')[0], '447700900123');
  check('Airtable formula compares digits only',
    airtable.phoneMatchFormula('phone_number', '+447700900123').includes("REGEX_REPLACE({phone_number} & '', '[^0-9]', '') = '447700900123'"), true);
  check('empty phone -> no formula', airtable.phoneMatchFormula('phone_number', ''), null);

  console.log('\nLINKING THE WEBSITE CLIENT ID');
  const realFind = airtable.findUserRecord;
  const lk = await makeUser({ short_id: 'Ai-BACKEND1', client_id: 'Ai-BKND01', phone_number: 'whatsapp:+447700900777' });
  let askedWith = null;
  airtable.findUserRecord = async (q) => { askedWith = q; return { id: 'rec1', fields: { 'Client ID': 'Ai-WEB123', Status: 'Approved' } }; };
  config.templates.status_approved = 'HXapproved';
  const outcome = await gateway.admit(await fresh(lk.id), { phoneNumber: 'whatsapp:+447700900777', incomingText: 'hi' });
  airtable.findUserRecord = realFind;
  check('looked up with both backend ids', JSON.stringify(askedWith?.clientId), JSON.stringify(['Ai-BACKEND1', 'Ai-BKND01']));
  row = await fresh(lk.id);
  check('short_id now the website id', row.short_id, 'Ai-WEB123');
  check('client_id now the website id', row.client_id, 'Ai-WEB123');
  check('status taken from Airtable', row.onboarding_phase, 'Approved');
  check('stopped at the front door', outcome.halt, true);
  check('approved template button carries the website id', lastSent().variables?.[2], 'Ai-WEB123');

  const lk2 = await makeUser({ short_id: 'Ai-BACKEND2', client_id: 'Ai-BKND02', phone_number: 'whatsapp:+447700900778' });
  r = await post('/admin/users/status-changed', { client_id: 'Ai-WEB456', phone: '07700 900778', status: 'Waitlist' });
  check('Airtable trigger finds "07700 900778" = whatsapp:+447700900778', r.json?.user_id, lk2.id);
  check('and links the website id', (await fresh(lk2.id)).short_id, 'Ai-WEB456');
  const dup = await makeUser({ short_id: 'Ai-DUP0001', client_id: 'Ai-DUP01', phone_number: 'whatsapp:+447700900779' });
  airtable.findUserRecord = async () => ({ id: 'rec2', fields: { 'Client ID': 'Ai-WEB123', Status: 'Waitlist' } });
  await gateway.admit(await fresh(dup.id), { phoneNumber: 'whatsapp:+447700900779', incomingText: 'hi' });
  airtable.findUserRecord = realFind;
  check('id already used by another account -> left alone, no crash', (await fresh(dup.id)).short_id, 'Ai-DUP0001');

  console.log('\nFRONT DOOR TEST NUMBERS');
  check('gate is off for everyone', config.gate.enabled, false);
  config.gate.testNumbers = ['+447700900999'];
  const beforeGate = sent.length;
  await fetch(`${base}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: 'whatsapp:+447700900999', Body: 'hello', MessageSid: 'SMtestgate1' }),
  });
  check('a test number goes through the front door', sent.length, beforeGate + 1);
  check('unknown test number gets the invitation', /by invitation/.test(lastSent().body || ''), true);

  console.log('\nADMIN TEST TOOLS');
  const tim = await makeUser({ onboarding_phase: 'Approved', active_timezone: 'Europe/London',
    preferences: { date_night: { partner_name: 'Alex' } } });
  const bystander = await makeUser({ onboarding_phase: 'Approved', date_night_cadence: 14,
    next_date_due_at: new Date(Date.now() - 3600e3) });
  config.testTools.userIds = [tim.id];
  check('not a test account -> 403', (await post(`/admin/test/${bystander.id}/run`, {})).status, 403);
  check('bad uuid -> 400', (await post('/admin/test/nope/run', {})).status, 400);
  check('unknown job -> 400', (await post(`/admin/test/${tim.id}/run`, { jobs: ['banana'] })).status, 400);
  check('no token -> 401', (await post(`/admin/test/${tim.id}/run`, {}, { 'Content-Type': 'application/json' })).status, 401);

  r = await post(`/admin/test/${tim.id}/date-night-due`, { cadence_days: 7 });
  check('date-night-due -> cadence 7', r.json?.date_night_cadence, 7);
  check('date-night-due -> due now', new Date(r.json?.next_date_due_at) <= new Date(), true);
  r = await post(`/admin/test/${tim.id}/date-night-due`, {});
  check('no cadence given -> keeps 7', r.json?.date_night_cadence, 7);

  // Whatever the hour is now, the test run pings: London9/13 rule is ignored.
  r = await post(`/admin/test/${tim.id}/run`, { jobs: ['date_night'] });
  check('date night pinged now, any hour', r.json?.results?.date_night?.pinged, 1);
  check('date night for the test user only', r.json?.results?.date_night?.due, 1);
  check('ping went to the test user', lastSent().to, tim.phone_number);
  check('{{2}} weekly', lastSent().variables?.[2], 'weekly');
  check('bystander not pinged', await countSends(bystander.id, 'datenight_ping'), 0);
  check('switches reported', typeof r.json?.switches?.date_night_ping, 'boolean');

  await pastSend(tim.id, 'status_approved', 1);
  await pastSend(bystander.id, 'status_approved', 1);
  r = await post(`/admin/test/${tim.id}/run`, { jobs: ['onboarding_reminder'] });
  check('reminder, invited 1h ago, waits honoured -> nothing', r.json?.results?.onboarding_reminder?.sent, 0);
  r = await post(`/admin/test/${tim.id}/run`, { jobs: ['onboarding_reminder'], ignore_wait: true });
  check('reminder with ignore_wait -> sent', r.json?.results?.onboarding_reminder?.sent, 1);
  check('reminder not sent to bystander', await countSends(bystander.id, 'onboarding_reminder'), 0);

  await db.query("UPDATE users SET onboarding_phase = 'Active', activated_at = NOW() - INTERVAL '1 hour' WHERE id = ANY($1::uuid[])",
    [[tim.id, bystander.id]]);
  await wrote(tim.id, 0.1, 'Two ideas:\n1. Sushi at Dinings, 19:00\n2. Pasta at Bocca di Lupo, 20:00');
  await wrote(bystander.id, 0.1, 'Two ideas:\n1. Sushi at Dinings, 19:00\n2. Pasta at Bocca di Lupo, 20:00');
  r = await post(`/admin/test/${tim.id}/run`, { jobs: ['handshake_ping', 'proposal_nudge'] });
  check('handshake, activated 1h ago -> nothing', r.json?.results?.handshake_ping?.sent, 0);
  check('nudge, options 6 min ago -> nothing', r.json?.results?.proposal_nudge?.sent, 0);
  r = await post(`/admin/test/${tim.id}/run`, { jobs: ['handshake_ping', 'proposal_nudge'], ignore_wait: true });
  check('handshake with ignore_wait (even mid-chat) -> sent', r.json?.results?.handshake_ping?.sent, 1);
  check('nudge with ignore_wait -> sent', r.json?.results?.proposal_nudge?.sent, 1);
  check('bystander: no handshake', await countSends(bystander.id, 'handshake_ping'), 0);
  check('bystander: no nudge', await countSends(bystander.id, 'proposal_nudge'), 0);
  r = await post(`/admin/test/${tim.id}/run`, { ignore_wait: true });
  check('all jobs again -> nothing repeats',
    ['onboarding_reminder', 'handshake_ping', 'proposal_nudge'].every((j) => r.json?.results?.[j]?.sent === 0)
      && r.json?.results?.date_night?.pinged === 0, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
