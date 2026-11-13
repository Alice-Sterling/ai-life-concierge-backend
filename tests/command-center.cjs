/**
 * Command Center (Project 4): message log, take-over and auto-resume, human
 * send, audit trail, token scopes, send locks, voice notes.
 *
 * Boots the real app against a THROWAWAY database and DROPS its schema.
 * Twilio and Whisper are stubbed: nothing leaves this machine.
 *
 *   SB_URL=postgres://... node tests/command-center.cjs
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
  { actor: 'office-only', token: 'cc-office-token-0123456789', scope: 'write', ips: ['203.0.113.7', '198.51.100.0/24'] },
  { actor: 'too-short', token: 'short', scope: 'write' },
]);
process.env.ADMIN_CORS_ORIGINS = 'https://command.example.test';
// A real-looking but fake Twilio account: the client object is built without
// any network call, and messages.create is replaced below.
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+440000000000';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_key_for_local_tests';
for (const k of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'EMAIL_HOST', 'EMAIL_CONFIG',
  'SLACK_WEBHOOK_URL', 'STATUS_GATE_ENABLED', 'STATUS_GATE_TEST_NUMBERS', 'ADMIN_IP_ALLOWLIST', 'TWILIO_TPL_WEEKLY_BRIEFING']) {
  delete process.env[k];
}

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { config } = require('../src/config');
const db = require('../src/db/pool');
const twilio = require('../src/integrations/twilio');
const airtable = require('../src/integrations/airtable');
const transcription = require('../src/integrations/transcription');
const messages = require('../src/services/messages');
const users = require('../src/services/users');
const templates = require('../src/services/templates');
const sendLocks = require('../src/services/sendLocks');
const commandCenter = require('../src/services/commandCenter');
const deskAlerts = require('../src/services/deskAlerts');
const resumeJob = require('../src/jobs/humanModeResume');
const webhook = require('../src/routes/webhook');
const auth = require('../src/middleware/adminAuth');
const audit = require('../src/middleware/adminAudit');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

// ---- Twilio stub: every send lands here instead of on the network ----------
const twilioSends = [];
let twilioFails = false;
twilio.client.messages.create = async (payload) => {
  if (twilioFails) throw Object.assign(new Error('stubbed Twilio failure'), { code: 63016 });
  twilioSends.push(payload);
  return { sid: `SMstub${String(twilioSends.length).padStart(4, '0')}` };
};

// ---- fetch stub: local calls pass through, Twilio media and Whisper are faked
const realFetch = global.fetch;
let whisper = { status: 200, body: { text: 'Book a table for two on Friday' } };
const outsideCalls = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  outsideCalls.push(u);
  if (u.includes('api.twilio.com')) {
    return new Response(Buffer.from('OggS-fake-audio-bytes'), { status: 200, headers: { 'content-type': 'audio/ogg' } });
  }
  if (u.includes('/audio/transcriptions')) {
    return new Response(JSON.stringify(whisper.body), { status: whisper.status, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

let base;
const CC = { Authorization: 'Bearer cc-write-token-0123456789', 'Content-Type': 'application/json' };
const READ = { Authorization: 'Bearer cc-read-token-0123456789', 'Content-Type': 'application/json' };
const LEGACY = { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' };

const call = async (p, opts = {}) => {
  const res = await realFetch(base + p, opts);
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* keep text */ }
  return { status: res.status, body, headers: res.headers };
};
const post = (p, body, headers = CC) => call(p, { method: 'POST', headers, body: JSON.stringify(body) });
const whatsapp = (fields) => call('/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

let n = 0;
async function addUser(phase = 'Active', extra = {}) {
  n += 1;
  const phone = `whatsapp:+4477009${String(n).padStart(5, '0')}`;
  const { rows } = await db.query(
    `INSERT INTO users (phone_number, first_name, last_name, onboarding_phase, client_id, preferences, activated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
    [phone, extra.first || `Client${n}`, extra.last || 'Test', phase, `Ai-CC${n}`,
      JSON.stringify(extra.preferences || {}), extra.activatedAt || null]);
  return rows[0];
}
const rowsFor = async (userId) => (await db.query(
  'SELECT direction, sender_type, content, metadata FROM messages WHERE user_id = $1 ORDER BY created_at, id', [userId])).rows;
const userRow = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
// The audit row is written after the response is sent; give it a moment.
const settle = () => new Promise((r) => setTimeout(r, 150));

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql', '008_command_center.sql']) {
    await db.query(read('db', 'sql', f));
  }
  // Applying 008 twice must be harmless.
  await db.query(read('db', 'sql', '008_command_center.sql'));

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ------------------------------------------------------------------ pure
  console.log('\nPURE HELPERS');
  check('exact IP', auth.ipMatches('203.0.113.7', '203.0.113.7'), true);
  check('IPv4-mapped IPv6 is the same address', auth.ipMatches('::ffff:203.0.113.7', '203.0.113.7'), true);
  check('CIDR inside', auth.ipMatches('198.51.100.42', '198.51.100.0/24'), true);
  check('CIDR outside', auth.ipMatches('198.51.101.42', '198.51.100.0/24'), false);
  check('empty allowlist allows all', auth.ipAllowed('10.1.2.3', []), true);
  check('non-empty allowlist blocks others', auth.ipAllowed('10.1.2.3', ['203.0.113.7']), false);
  check('actor header: normal email kept', auth.cleanActorHeader('alice@example.com'), 'alice@example.com');
  check('actor header: newline injection dropped', auth.cleanActorHeader('alice\nadmin'), null);
  check('a token under 16 characters is not accepted', config.admin.tokens.some((t) => t.actor === 'too-short'), false);
  check('redact: tokens removed at any depth',
    audit.redact({ access_token: 'abc', nested: { refresh_token: 'def', keep: 'x' }, content: 'hello' }),
    { access_token: '[redacted]', nested: { refresh_token: '[redacted]', keep: 'x' }, content: 'hello' });
  check('redact: long strings cut', audit.redact({ a: 'x'.repeat(900) }).a.length < 600, true);
  check('audit action names', [audit.actionFor('POST', '/messages/send'), audit.actionFor('POST', '/users/abc/mode'), audit.actionFor('GET', '/unknown')],
    ['message.send', 'conversation_mode.set', 'GET /unknown']);
  check('ISO week', [sendLocks.isoWeek(new Date('2026-11-13T12:00:00Z')), sendLocks.isoWeek(new Date('2027-01-01T12:00:00Z'))], ['2026-W46', '2026-W53']);
  check('trial window: 180 days from activation', users.trialWindow(
    { activated_at: '2026-10-01T00:00:00Z', trial_duration_days: 180 }, new Date('2026-11-12T00:00:00Z')).trial_days_left, 138);
  check('trial window: nothing known -> null', users.trialWindow({ trial_duration_days: 180 }), null);
  check('mode note: admin actor named', users.modeNote('human', 'admin:command-center:alice@x.co'), 'Human mode engaged by command-center:alice@x.co.');
  check('mode note: auto resume', users.modeNote('ai', 'auto_resume'), 'Alice resumed automatically: the human window ended.');
  const links = commandCenter.taskLinks('Book Doppo for 2, Fri 19:30.\n\nBooking link: https://www.opentable.co.uk/r/doppo?covers=2\nVendor phone: +44 20 7946 0000\nPrice: £75');
  check('task links: booking url', links.booking_url, 'https://www.opentable.co.uk/r/doppo?covers=2');
  check('task links: tel link', links.tel_link, 'tel:+442079460000');
  check('task links: price', links.price, '£75');
  check('task links: nothing there -> nulls', commandCenter.taskLinks('Call the client back.').booking_url, null);
  check('headline', commandCenter.headline({ account_status: 'Active', cohort_id: 'cohort_1_alpha' }, { trial_days_left: 42 }),
    'Active | cohort_1_alpha | Trial expires in 42 days');
  check('audio media found', transcription.audioMedia({ NumMedia: '2', MediaUrl0: 'https://api.twilio.com/a', MediaContentType0: 'image/jpeg', MediaUrl1: 'https://api.twilio.com/b', MediaContentType1: 'audio/ogg; codecs=opus' }).length, 1);
  check('media URL: Twilio accepted', transcription.isTwilioMediaUrl('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1'), true);
  check('media URL: other host refused', transcription.isTwilioMediaUrl('https://evil.example/twilio.com/a.ogg'), false);
  check('media URL: http refused', transcription.isTwilioMediaUrl('http://api.twilio.com/a'), false);
  const spec = { table: 'Tasks', required: ['Task ID', 'Status'], optional: ['Price'] };
  check('airtable compare: all there', airtable.compareTable(spec, ['Task ID', 'Status', 'Price']).ok, true);
  check('airtable compare: renamed field found', airtable.compareTable(spec, ['Task ID', 'State']).missing_fields, ['Status']);
  check('airtable compare: optional only reported', airtable.compareTable(spec, ['Task ID', 'Status']).ok, true);
  check('required Airtable tables listed', airtable.requiredSchema().map((s) => s.key), ['clients', 'tasks']);

  // ------------------------------------------------------------------ schema
  console.log('\nSCHEMA (migration 008)');
  const phases = {};
  for (const ph of ['Waitlist', 'Approved', 'Denied', 'Onboarded', 'Active', 'Inactive']) phases[ph] = (await addUser(ph)).account_status;
  check('account_status follows onboarding_phase', phases,
    { Waitlist: 'Waitlist', Approved: 'Waitlist', Denied: 'Denied', Onboarded: 'Waitlist', Active: 'Active', Inactive: 'Cancelled' });
  const pausable = await addUser('Active');
  await db.query(`UPDATE users SET onboarding_phase = 'Inactive', account_status = 'Paused' WHERE id = $1`, [pausable.id]);
  check('an explicit pause is kept', (await userRow(pausable.id)).account_status, 'Paused');
  await users.setOnboardingPhase(pausable.id, 'Active');
  check('reactivation -> Active again', (await userRow(pausable.id)).account_status, 'Active');
  check('trial length defaults to 180', (await userRow(pausable.id)).trial_duration_days, 180);

  // ------------------------------------------------------------------ message log
  console.log('\nMESSAGE LOG');
  const tim = await addUser('Active', { first: 'Tim', last: 'Antos', activatedAt: new Date(Date.now() - 10 * 86400e3).toISOString(),
    preferences: { lifestyle_preferences: { home_city: 'London', dietary_restrictions: 'gluten-free', partner_name: 'Ana' } } });
  let r = await whatsapp({ From: tim.phone_number, Body: 'Hello Alice', MessageSid: 'SMin0001' });
  check('webhook answers 200', r.status, 200);
  check('batched: the reply comes later through the API', r.body.trim(), '<Response></Response>');
  let log = await rowsFor(tim.id);
  check('the inbound message is logged', [log.length, log[0]?.direction, log[0]?.sender_type, log[0]?.content], [1, 'inbound', 'user', 'Hello Alice']);
  check('with its Twilio sid', log[0]?.metadata.twilio_sid, 'SMin0001');
  await whatsapp({ From: tim.phone_number, Body: 'Hello Alice', MessageSid: 'SMin0001' });
  check('a Twilio retry (same sid) is not logged twice', (await rowsFor(tim.id)).length, 1);

  // Alice's reply goes out through the batcher's sender.
  const batcher = require('../src/services/messageBatcher');
  twilioSends.length = 0;
  // The batcher waits for the client to stop typing; make the burst look finished.
  await db.query(`UPDATE pending_messages SET received_at = NOW() - INTERVAL '5 minutes' WHERE user_id = $1`, [tim.id]);
  await batcher.processNextBatch(async () => 'Good evening, Tim. How may I help?');
  log = await rowsFor(tim.id);
  check('Alice\'s reply is logged as alice', [log[1]?.direction, log[1]?.sender_type, log[1]?.content], ['outbound', 'alice', 'Good evening, Tim. How may I help?']);
  check('and went to Twilio once', twilioSends.length, 1);
  check('with the stub sid recorded', /^SMstub/.test(log[1]?.metadata.twilio_sid || ''), true);

  // ------------------------------------------------------------------ take over
  console.log('\nTAKE OVER (Scenario B)');
  r = await post(`/admin/users/${tim.id}/mode`, { mode: 'human' }, { ...CC, 'X-Admin-Actor': 'alice@example.com' });
  check('mode -> human', [r.status, r.body.conversation_mode], [200, 'human']);
  const until = new Date(r.body.human_override_until).getTime();
  check('human window is two hours ahead', Math.abs(until - Date.now() - 120 * 60e3) < 60e3, true);
  log = await rowsFor(tim.id);
  check('system note names who took over', [log[2]?.sender_type, log[2]?.content], ['system', 'Human mode engaged by command-center:alice@example.com.']);

  deskAlerts._reset();
  r = await whatsapp({ From: tim.phone_number, Body: 'Are you there?', MessageSid: 'SMin0002' });
  check('first message in human mode: the holding line', r.body.includes(webhook.HUMAN_MODE_ACK), true);
  r = await whatsapp({ From: tim.phone_number, Body: 'Hello??', MessageSid: 'SMin0003' });
  check('second message: no repeated holding line', r.body.trim(), '<Response></Response>');
  log = await rowsFor(tim.id);
  check('both client lines and one holding line are logged',
    log.slice(3).map((m) => `${m.sender_type}:${m.content.slice(0, 14)}`), ['user:Are you there?', 'alice:Thank you. You', 'user:Hello??']);
  check('desk alert: once per ten minutes', [deskAlerts.shouldAlert(tim.id), deskAlerts.shouldAlert('someone-else')], [false, true]);

  r = await call('/admin/inbox', { headers: CC });
  check('inbox: Tim first, unread', [r.body.threads[0].user_id, r.body.threads[0].unread, r.body.threads[0].last_message], [tim.id, true, 'Hello??']);
  check('inbox: unread count', r.body.unread, 1);

  // ------------------------------------------------------------------ human send
  console.log('\nHUMAN SEND');
  twilioSends.length = 0;
  await db.query(`UPDATE users SET human_override_until = NOW() + INTERVAL '5 minutes' WHERE id = $1`, [tim.id]);
  r = await post('/admin/messages/send', { user_id: tim.id, content: 'Hi Tim, Sam from the desk here.' }, { ...CC, 'X-Admin-Actor': 'sam@example.com' });
  check('send -> 200', [r.status, r.body.ok, r.body.sender_type], [200, true, 'human_agent']);
  check('Twilio got the text and the number', [twilioSends[0]?.body, twilioSends[0]?.to], ['Hi Tim, Sam from the desk here.', tim.phone_number]);
  log = await rowsFor(tim.id);
  const sent = log[log.length - 1];
  check('logged as human_agent with the actor', [sent.sender_type, sent.direction, sent.metadata.actor], ['human_agent', 'outbound', 'command-center:sam@example.com']);
  check('sending restarts the human window', new Date((await userRow(tim.id)).human_override_until).getTime() - Date.now() > 100 * 60e3, true);
  check('no second "human mode engaged" note', log.filter((m) => m.sender_type === 'system').length, 1);
  r = await call('/admin/inbox', { headers: CC });
  check('inbox: answered, so no longer unread', r.body.threads[0].unread, false);

  r = await post('/admin/messages/send', { user_id: tim.id, content: 'Hi Tim, Sam from the desk here.' });
  check('double click -> 409, not a second message', [r.status, r.body.code, twilioSends.length], [409, 'duplicate_send', 1]);
  r = await post('/admin/messages/send', { user_id: tim.id, content: '   ' });
  check('empty -> 400', [r.status, r.body.code], [400, 'empty_message']);
  r = await post('/admin/messages/send', { user_id: tim.id, content: 'x'.repeat(1601) });
  check('too long -> 400', [r.status, r.body.code], [400, 'message_too_long']);
  r = await post('/admin/messages/send', { user_id: '00000000-0000-4000-8000-000000000000', content: 'hi' });
  check('unknown client -> 404', r.status, 404);
  r = await post('/admin/messages/send', { user_id: 'nope', content: 'hi' });
  check('bad id -> 400', r.status, 400);

  const quiet = await addUser('Active', { first: 'Quiet' });
  await db.query(`INSERT INTO messages (user_id, direction, sender_type, content, created_at) VALUES ($1, 'inbound', 'user', 'old', NOW() - INTERVAL '30 hours')`, [quiet.id]);
  r = await post('/admin/messages/send', { user_id: quiet.id, content: 'Are you still looking for a table?' });
  check('outside the 24-hour window -> 409, nothing sent', [r.status, r.body.code, twilioSends.length], [409, 'outside_24h_window', 1]);
  check('and the client stays with Alice', (await userRow(quiet.id)).conversation_mode, 'ai');

  const fresh = await addUser('Active', { first: 'Fresh' });
  await whatsapp({ From: fresh.phone_number, Body: 'Can someone call me?', MessageSid: 'SMin0010' });
  commandCenter._resetSends();
  r = await post('/admin/messages/send', { user_id: fresh.id, content: 'Of course. Calling in five minutes.' });
  check('sending to a client who is with Alice takes over', [r.status, (await userRow(fresh.id)).conversation_mode], [200, 'human']);
  check('with a human window', Boolean((await userRow(fresh.id)).human_override_until), true);
  log = await rowsFor(fresh.id);
  check('note first, then the message', log.slice(-2).map((m) => m.sender_type), ['system', 'human_agent']);

  twilioFails = true;
  commandCenter._resetSends();
  r = await post('/admin/messages/send', { user_id: fresh.id, content: 'This one will be refused.' });
  twilioFails = false;
  check('Twilio refuses -> 502', [r.status, r.body.code], [502, 'twilio_send_failed']);
  log = await rowsFor(fresh.id);
  check('a note says it was not delivered', /was not delivered/.test(log[log.length - 1].content), true);
  check('the refused text is not shown as sent', log.some((m) => m.content === 'This one will be refused.'), false);

  // ------------------------------------------------------------------ auto resume
  console.log('\nAUTO-RESUME (Scenario C)');
  const stillTalking = await addUser('Active', { first: 'Still' });
  await users.setConversationMode(stillTalking.id, 'human', { source: 'alice_handoff_tool' });
  const legacyRow = await addUser('Active', { first: 'Legacy' });
  await db.query(`UPDATE users SET conversation_mode = 'human', conversation_mode_changed_at = NOW() - INTERVAL '3 hours', human_override_until = NULL WHERE id = $1`, [legacyRow.id]);
  await db.query(`UPDATE users SET human_override_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [tim.id]);
  // The client keeps writing: that must not hold Alice back once the window is over.
  await whatsapp({ From: tim.phone_number, Body: 'Anyone?', MessageSid: 'SMin0004' });
  const sweep = await resumeJob.runSweep();
  check('two expired windows resumed (Tim, and the row from before 008)', sweep.resumed, 2);
  const timNow = await userRow(tim.id);
  check('Tim is back with Alice, window cleared', [timNow.conversation_mode, timNow.human_override_until], ['ai', null]);
  check('a client inside the window stays with the human', [(await userRow(stillTalking.id)).conversation_mode, (await userRow(fresh.id)).conversation_mode], ['human', 'human']);
  log = await rowsFor(tim.id);
  check('the chat shows the resume', log[log.length - 1].content, 'Alice resumed automatically: the human window ended.');
  check('hand-off by Alice has its own note', (await rowsFor(stillTalking.id))[0].content, 'Human mode engaged: Alice handed this client to the desk.');
  r = await post(`/admin/users/${stillTalking.id}/mode`, { mode: 'ai' });
  check('hand back by the desk clears the window', [r.body.conversation_mode, r.body.human_override_until], ['ai', null]);
  check('the 5-minute schedule', /\*\/5 \* \* \* \*/.test(read('src', 'jobs', 'humanModeResume.js')), true);

  // ------------------------------------------------------------------ read endpoints
  console.log('\nREAD ENDPOINTS');
  r = await call('/admin/users', { headers: READ });
  const listed = r.body.users.find((u) => u.id === tim.id);
  check('users: status, cohort, mode', [listed.account_status, listed.cohort_id, listed.mode], ['Active', null, 'ai']);
  check('users: trial days left from activation', listed.trial_days_left, 170);
  r = await call(`/admin/conversations/${tim.id}`, { headers: READ });
  check('conversation: messages oldest first', [r.status, r.body.messages[0].content, r.body.message_count > 5], [200, 'Hello Alice', true]);
  check('conversation: the old exchange list is still there', Array.isArray(r.body.conversations), true);
  check('conversation: every row has direction and sender_type',
    r.body.messages.every((m) => messages.DIRECTIONS.includes(m.direction) && messages.SENDER_TYPES.includes(m.sender_type)), true);
  await db.query(`INSERT INTO tasks (user_id, ai_summary, category, status, created_at) VALUES
    ($1, 'Old task', 'general', 'completed', NOW() - INTERVAL '4 days'),
    ($1, 'Second', 'general', 'new', NOW() - INTERVAL '3 days'),
    ($1, 'Third', 'general', 'new', NOW() - INTERVAL '2 days'),
    ($1, E'Book Doppo.\\n\\nBooking link: https://www.opentable.co.uk/r/doppo\\nVendor phone: 020 7946 0000', 'date_night', 'in_progress', NOW() - INTERVAL '1 day')`, [tim.id]);
  r = await call(`/admin/users/${tim.id}/context`, { headers: READ });
  check('context: headline', r.body.headline, 'Active | Trial expires in 170 days');
  check('context: lifestyle preferences', r.body.lifestyle_preferences, { 'Home City': 'London', 'Partner Name': 'Ana', 'Dietary Restrictions': 'gluten-free' });
  check('context: three latest tasks', r.body.recent_tasks.length, 3);
  check('context: task links for the desk', r.body.recent_tasks.find((t) => t.category === 'date_night')?.links.booking_url, 'https://www.opentable.co.uk/r/doppo');
  check('context: unknown client -> 404', (await call('/admin/users/00000000-0000-4000-8000-000000000000/context', { headers: READ })).status, 404);

  // ------------------------------------------------------------------ hardening
  console.log('\nHARDENING');
  check('no token -> 401', (await call('/admin/inbox')).status, 401);
  check('wrong token -> 401', (await call('/admin/inbox', { headers: { Authorization: 'Bearer nope-nope-nope-nope' } })).status, 401);
  check('read token can read', (await call('/admin/inbox', { headers: READ })).status, 200);
  r = await post(`/admin/users/${tim.id}/mode`, { mode: 'human' }, READ);
  check('read token cannot write', [r.status, (await userRow(tim.id)).conversation_mode], [403, 'ai']);
  r = await post('/admin/messages/send', { user_id: tim.id, content: 'hi' }, READ);
  check('read token cannot send', r.status, 403);
  check('IP-bound token from another address -> 403', (await call('/admin/inbox', { headers: { Authorization: 'Bearer cc-office-token-0123456789' } })).status, 403);
  check('the original shared token still works (n8n)', (await call('/admin/users', { headers: LEGACY })).status, 200);
  r = await call('/admin/inbox', { method: 'OPTIONS', headers: { Origin: 'https://command.example.test', 'Access-Control-Request-Method': 'GET' } });
  check('CORS: listed origin allowed', [r.status, r.headers.get('access-control-allow-origin')], [204, 'https://command.example.test']);
  r = await call('/admin/inbox', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  check('CORS: other origin refused', [r.status, r.headers.get('access-control-allow-origin')], [403, null]);

  await post('/admin/calendar/connect', { provider: 'google', access_token: 'ya29.secret-value', refresh_token: 'also-secret' }, LEGACY);
  await settle();
  const auditRows = (await db.query('SELECT actor, action, user_id, status_code, request_body_redacted AS body, request_id FROM admin_audit_logs ORDER BY id')).rows;
  const find = (pred) => auditRows.find(pred);
  const takeover = find((a) => a.action === 'conversation_mode.set' && a.actor === 'command-center:alice@example.com');
  check('audit: the take-over, with who and on whom', [takeover?.user_id, takeover?.status_code, takeover?.body.mode], [tim.id, 200, 'human']);
  const sendAudit = find((a) => a.action === 'message.send' && a.status_code === 200);
  check('audit: the message send', [sendAudit?.actor, sendAudit?.user_id], ['command-center:sam@example.com', tim.id]);
  check('audit: refused calls are recorded too',
    [Boolean(find((a) => a.actor === 'unauthenticated' && a.status_code === 401)), Boolean(find((a) => a.actor === 'reporting' && a.status_code === 403)), Boolean(find((a) => a.actor === 'office-only' && a.status_code === 403))],
    [true, true, true]);
  const connect = find((a) => a.action === 'calendar.connect');
  check('audit: tokens never stored', [connect?.body.access_token, connect?.body.refresh_token, connect?.body.provider], ['[redacted]', '[redacted]', 'google']);
  check('audit: every row has a request id', auditRows.every((a) => a.request_id), true);
  r = await call(`/admin/audit?user_id=${tim.id}`, { headers: READ });
  check('audit can be read back, per client', [r.status, r.body.entries.every((e) => e.user_id === tim.id), r.body.count > 2], [200, true, true]);

  // ------------------------------------------------------------------ send locks
  console.log('\nSEND LOCKS (no duplicate proactive sends)');
  twilioSends.length = 0;
  const lockUser = await userRow(tim.id);
  const first = await templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W46' });
  const second = await templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W46' });
  check('first send goes out', [first.sent, twilioSends.length], [true, 1]);
  check('the same period again is blocked', [second.sent, second.duplicate, twilioSends.length], [false, true, 1]);
  const both = await Promise.all([
    templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W47' }),
    templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W47' }),
  ]);
  check('two jobs at the same moment: exactly one sends', [both.filter((b) => b.sent).length, twilioSends.length], [1, 2]);
  twilioFails = true;
  const refused = await templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W48' });
  twilioFails = false;
  const retry = await templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true, periodKey: '2026-W48' });
  check('a refused send gives the lock back, so the retry sends', [refused.sent, retry.sent], [false, true]);
  const noKey = await templates.send('weekly_briefing', { to: lockUser.phone_number, user: lockUser, inWindow: true });
  check('no period key -> behaves as before', noKey.sent, true);
  log = await rowsFor(tim.id);
  const tpl = log.filter((m) => m.metadata.template_key === 'weekly_briefing');
  check('template sends are in the chat log as readable text', [tpl.length, tpl[0].sender_type, tpl[0].content.length > 20], [4, 'alice', true]);

  // ------------------------------------------------------------------ voice notes
  console.log('\nVOICE NOTES (Scenario D)');
  const voice = { From: tim.phone_number, Body: '', NumMedia: '1', MediaContentType0: 'audio/ogg; codecs=opus',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM1/Media/ME1' };
  check('no key: voice notes are off', transcription.isConfigured(), false);
  outsideCalls.length = 0;
  await whatsapp({ ...voice, MessageSid: 'SMvoice0' });
  log = await rowsFor(tim.id);
  check('no key: nothing is downloaded, a placeholder is logged', [outsideCalls.length, log[log.length - 1].content], [0, messages.VOICE_PLACEHOLDER]);

  config.transcription.keys.groq = 'gsk_test_key';
  check('with a Groq key: on, provider groq', [transcription.isConfigured(), transcription.provider()], [true, 'groq']);
  r = await whatsapp({ ...voice, MessageSid: 'SMvoice1' });
  log = await rowsFor(tim.id);
  check('transcript logged with the prefix', log[log.length - 1].content, '[AUDIO TRANSCRIPT] Book a table for two on Friday');
  check('marked as a transcribed voice note', log[log.length - 1].metadata.voice_note, 'transcribed');
  check('audio came from Twilio and went to Groq', [outsideCalls.some((u) => u.includes('api.twilio.com')), outsideCalls.some((u) => u.startsWith('https://api.groq.com/openai/v1/audio/transcriptions'))], [true, true]);
  const queued = (await db.query(`SELECT body FROM pending_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [tim.id])).rows[0];
  check('Alice receives the transcript as the message', queued.body, '[AUDIO TRANSCRIPT] Book a table for two on Friday');

  await whatsapp({ ...voice, Body: 'See my note', MessageSid: 'SMvoice2' });
  log = await rowsFor(tim.id);
  check('caption and transcript together', log[log.length - 1].content, 'See my note\n[AUDIO TRANSCRIPT] Book a table for two on Friday');

  whisper = { status: 500, body: { error: 'boom' } };
  r = await whatsapp({ ...voice, MessageSid: 'SMvoice3' });
  check('transcription fails: the client is asked to type', r.body.includes('Could you type that for me?'), true);
  log = await rowsFor(tim.id);
  check('failure is visible in the chat log', log.slice(-2).map((m) => [m.sender_type, m.metadata.voice_note]), [['user', 'failed'], ['alice', 'failed']]);

  whisper = { status: 200, body: { text: 'should never be used' } };
  outsideCalls.length = 0;
  r = await whatsapp({ ...voice, MediaUrl0: 'https://evil.example/steal.ogg', MessageSid: 'SMvoice4' });
  check('a media URL that is not Twilio is never fetched', [outsideCalls.length, r.body.includes('Could you type that for me?')], [0, true]);

  config.transcription.keys.groq = null;
  config.transcription.keys.openai = 'sk-test';
  outsideCalls.length = 0;
  await whatsapp({ ...voice, MessageSid: 'SMvoice5' });
  check('OpenAI key instead: goes to OpenAI', outsideCalls.some((u) => u.startsWith('https://api.openai.com/v1/audio/transcriptions')), true);
  config.transcription.keys.openai = null;

  await users.setConversationMode(tim.id, 'human', { source: 'admin:test' });
  config.transcription.keys.groq = 'gsk_test_key';
  whisper = { status: 200, body: { text: 'Please call me back' } };
  await whatsapp({ ...voice, MessageSid: 'SMvoice6' });
  log = await rowsFor(tim.id);
  check('in human mode the desk sees the transcript', log.some((m) => m.content === '[AUDIO TRANSCRIPT] Please call me back'), true);
  config.transcription.keys.groq = null;

  // ------------------------------------------------------------------ health
  console.log('\nHEALTH');
  r = await call('/health/airtable-schema');
  check('airtable-schema: answers, not configured here', [r.status, r.body.status], [200, 'not_configured']);
  r = await call('/health');
  check('liveness unchanged', [r.status, r.body.status], [200, 'ok']);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.pool.end();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FAILED:', err.message, '\n', err.stack);
  process.exit(1);
});
