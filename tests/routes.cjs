/**
 * Route-level integration test.
 *
 * Boots the real app against a THROWAWAY database, drops and rebuilds the
 * schema, then drives every route. Never point this at anything you care about.
 *
 *   TEST_DATABASE_URL=postgres://... node tests/routes.cjs
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
// A syntactically valid but fake key: the Stripe client is constructed without
// any network call, and the test drives the handler past the relaxed signature
// check that applies outside production.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_key_for_local_tests';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const db = require('../src/db/pool');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let server;
let base;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

const call = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  // Read once as text: a Response body is a stream and can only be consumed
  // once, so trying .json() then falling back to .text() throws.
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* not JSON; keep the raw text */ }
  return { status: res.status, body, headers: res.headers };
};

const form = (obj) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(obj).toString(),
});

const AUTH = { Authorization: 'Bearer test-admin-token-12345' };

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  await db.query(read('db', 'sql', '001a_prepare.sql'));
  await db.query(read('db', 'sql', '001b_finalize.sql'));
  await db.query(read('db', 'sql', '003_timezone_and_tokens.sql'));
  await db.query(read('db', 'sql', '004_message_batching.sql'));

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nPUBLIC');
  check('GET /health', (await call('/health')).status, 200);
  check('GET / renders the landing page', (await call('/')).status, 200);
  const rd = await fetch(base + '/portal', { redirect: 'manual' });
  check('GET /portal is a 301', rd.status, 301);
  check('GET /portal points at /', rd.headers.get('location'), '/');
  check('GET /nope', (await call('/nope')).status, 404);

  console.log('\nWEBHOOK - new user');
  const w1 = await call('/webhook', form({ From: 'whatsapp:+447700900999', Body: 'Hello there', ProfileName: 'Grace' }));
  check('POST /webhook accepts an inbound message', w1.status, 200);
  const { rows: created } = await db.query(
    "SELECT id, first_name, conversation_mode, onboarding_phase FROM users WHERE phone_number = 'whatsapp:+447700900999'");
  check('the user was created', created.length, 1);
  check('the profile name was stored', created[0]?.first_name, 'Grace');
  check('conversation_mode defaults to ai', created[0]?.conversation_mode, 'ai');
  check('onboarding_phase defaults to Waitlist', created[0]?.onboarding_phase, 'Waitlist');

  const userId = created[0].id;
  const { rows: ev } = await db.query(
    "SELECT event_name FROM events WHERE event_name = 'whatsapp_started'");
  check('a whatsapp_started event was recorded', ev.length, 1);

  console.log('\nWEBHOOK - human hand-off gate');
  const flip = await call(`/admin/users/${userId}/mode`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_mode: 'human' }),
  });
  check('admin flips the user to human', flip.body?.conversation_mode, 'human');

  const w2 = await call('/webhook', form({ From: 'whatsapp:+447700900999', Body: 'Are you there?' }));
  check('POST /webhook still answers', w2.status, 200);
  check('the reply is the human-mode acknowledgement',
    String(w2.body).includes('with your concierge'), true);

  const { rows: queued } = await db.query(
    "SELECT ai_response, metadata FROM conversations WHERE message_body = 'Are you there?'");
  check('the message was stored', queued.length, 1);
  check('no AI reply was generated', queued[0]?.ai_response, null);
  check('it is flagged as queued', queued[0]?.metadata?.queued_for_human, true);

  const { rows: handoff } = await db.query(
    "SELECT status, assigned_to, requires_human FROM tasks WHERE user_id = $1", [userId]);
  check('a hand-off task was created', handoff.length, 1);
  check('the task is new', handoff[0]?.status, 'new');
  check('it is assigned to the operator', handoff[0]?.assigned_to, 'assist@ailifeconcierge.co.uk');

  const { rows: hev } = await db.query(
    "SELECT event_name FROM events WHERE event_name = 'human_handoff_created'");
  check('a human_handoff_created event was recorded', hev.length, 1);

  console.log('\nADMIN');
  check('GET /admin/users without a token', (await call('/admin/users')).status, 401);
  check('GET /admin/users with a bad token',
    (await call('/admin/users', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  check('GET /admin/users', (await call('/admin/users', { headers: AUTH })).status, 200);
  check('GET /admin/tasks?status=new', (await call('/admin/tasks?status=new', { headers: AUTH })).status, 200);
  check('GET /admin/tasks?status=bogus', (await call('/admin/tasks?status=bogus', { headers: AUTH })).status, 400);
  check('GET /admin/conversations/:id', (await call(`/admin/conversations/${userId}`, { headers: AUTH })).status, 200);
  check('GET /admin/conversations/garbage', (await call('/admin/conversations/garbage', { headers: AUTH })).status, 400);

  console.log('\nSTRIPE');
  const sp = await call('/stripe-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'bogus' },
    body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { phone: 'whatsapp:+447700900999' } } } }),
  });
  // Outside production the signature check is relaxed so the handler can be
  // driven by a test payload; in production this same request is a 400.
  check('POST /stripe-webhook processes the event', sp.status, 200);
  const { rows: up } = await db.query('SELECT tier, subscription_status FROM users WHERE id = $1', [userId]);
  check('the user was upgraded to pro', up[0]?.tier, 'pro');
  check('subscription_status is PRO', up[0]?.subscription_status, 'PRO');

  console.log('\nTRACEABILITY');
  const nf = await call('/nope');
  check('the request id is echoed in the body',
    nf.headers.get('x-request-id') === nf.body.request_id, true);

  server.close();
  await db.pool.end();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nFAILED:', e.message, '\n', e.stack);
  server?.close();
  process.exit(1);
});
