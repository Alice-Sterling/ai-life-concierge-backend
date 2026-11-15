/**
 * Membership in WhatsApp (cancel, pause, free month, resume) and the
 * voice-note feedback loop (Project 4).
 *
 * Boots the real app against a THROWAWAY database and DROPS its schema.
 * Stripe and Twilio are stubbed: nothing leaves this machine, no billing moves.
 *
 *   SB_URL=postgres://... node tests/membership.cjs
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set SB_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_membership_tests';
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+440000000000';
process.env.MEMBERSHIP_TOOLS_ENABLED = 'true';
process.env.STATUS_GATE_ENABLED = 'true';
process.env.AIRTABLE_PULL_ENABLED = 'false';
for (const k of ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'EMAIL_HOST', 'EMAIL_CONFIG', 'SLACK_WEBHOOK_URL', 'ANTHROPIC_API_KEY',
  'GROQ_API_KEY', 'OPENAI_API_KEY', 'STRIPE_FREE_MONTH_COUPON_ID', 'FEEDBACK_REQUEST_ENABLED', 'TWILIO_TPL_FEEDBACK_REQUEST',
  'TWILIO_TPL_MEMBERSHIP_INACTIVE', 'STATUS_GATE_TEST_NUMBERS', 'TEST_TOOLS_USER_IDS']) {
  delete process.env[k];
}

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { config } = require('../src/config');
const db = require('../src/db/pool');
const twilio = require('../src/integrations/twilio');
const stripeIntegration = require('../src/integrations/stripe');
const membership = require('../src/services/membership');
const feedback = require('../src/services/feedback');
const lifecycleJob = require('../src/jobs/lifecycle');
const promptBuilder = require('../src/agents/promptBuilder');
const messages = require('../src/services/messages');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

// ---- Twilio stub -----------------------------------------------------------
const twilioSends = [];
twilio.client.messages.create = async (payload) => {
  twilioSends.push(payload);
  return { sid: `SMstub${String(twilioSends.length).padStart(4, '0')}` };
};

// ---- Stripe stub: a tiny in-memory Stripe ------------------------------------
const stripe = stripeIntegration.client;
const stripeCalls = [];
let customers = [];       // [{ id, email }]
let subscriptions = {};   // id -> { id, customer, status, trial_end }
let stripeRefuses = false;
stripe.customers.list = async ({ email }) => ({ data: customers.filter((c) => c.email === email) });
stripe.subscriptions.list = async ({ customer }) => ({ data: Object.values(subscriptions).filter((s) => s.customer === customer) });
stripe.subscriptions.retrieve = async (id) => {
  if (!subscriptions[id]) throw Object.assign(new Error(`No such subscription: ${id}`), { type: 'StripeInvalidRequestError' });
  return subscriptions[id];
};
stripe.subscriptions.update = async (id, params) => {
  if (stripeRefuses) throw Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError' });
  stripeCalls.push({ op: 'update', id, params });
  return { ...subscriptions[id], ...params };
};
stripe.subscriptions.cancel = async (id) => {
  if (stripeRefuses) throw Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError' });
  stripeCalls.push({ op: 'cancel', id });
  subscriptions[id].status = 'canceled';
  return subscriptions[id];
};

let base;
const AUTH = { Authorization: 'Bearer test-admin-token-12345', 'Content-Type': 'application/json' };
const call = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* keep text */ }
  return { status: res.status, body };
};
const whatsapp = (fields) => call('/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});

let n = 0;
async function addMember({ first = 'Client', email = null, automations = ['date_night', 'gifting'], activatedDaysAgo = 30 } = {}) {
  n += 1;
  const phone = `whatsapp:+4477008${String(n).padStart(5, '0')}`;
  const { rows } = await db.query(
    `INSERT INTO users (phone_number, first_name, last_name, email, client_id, onboarding_phase, active_automations,
                        activated_at, welcome_message_sent, onboarding_status)
     VALUES ($1, $2, 'Test', $3, $4, 'Active', $5::jsonb, NOW() - make_interval(days => $6::int), true, 'complete') RETURNING *`,
    [phone, first, email || `member${n}@example.com`, `Ai-MB${n}`, JSON.stringify(automations), activatedDaysAgo]);
  return rows[0];
}
const userRow = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const tool = async (name, userId, input = {}) => JSON.parse(await membership.run(name, input, { userId, requestId: 'req-test' }));
const lastTask = async (userId) => (await db.query(
  'SELECT ai_summary, requires_human, priority, status FROM tasks WHERE user_id = $1 ORDER BY created_at DESC, task_id DESC LIMIT 1', [userId])).rows[0];
const eventCount = async (userId, name) => (await db.query(
  'SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1 AND event_name = $2', [userId, name])).rows[0].n;
const giveStripe = (user, status = 'trialing', extra = {}) => {
  const cid = `cus_${user.client_id}`;
  const sid = `sub_${user.client_id}`;
  customers.push({ id: cid, email: user.email });
  subscriptions[sid] = { id: sid, customer: cid, status, trial_end: 1_800_000_000, ...extra };
  return sid;
};

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  for (const f of ['001a_prepare.sql', '001b_finalize.sql', '003_timezone_and_tokens.sql', '004_message_batching.sql',
    '005_front_door.sql', '006_calendar_connection.sql', '007_lifecycle.sql', '008_command_center.sql', '009_membership_and_feedback.sql']) {
    await db.query(read('db', 'sql', f));
  }
  await db.query(read('db', 'sql', '009_membership_and_feedback.sql'));
  await db.query(read('db', 'sql', '009_membership_and_feedback_down.sql'));
  await db.query(read('db', 'sql', '009_membership_and_feedback.sql'));
  check('migration 009 applies twice, comes off, and goes back on', true, true);

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ------------------------------------------------------------------ prompt
  console.log('\nPROMPT');
  const someone = await addMember({ first: 'Prompt' });
  check('protocol block is in the prompt when the tools are on', /CANCELLATION & RETENTION PROTOCOL/.test(membership.promptBlock(someone.id)), true);
  check('it tells her a cancelled dinner is not a cancelled membership', /NOT a membership cancellation/.test(membership.promptBlock(someone.id)), true);
  check('the four tools are offered', membership.definitionsFor(someone.id).map((t) => t.name),
    ['retention_offer', 'apply_free_month', 'pause_membership', 'cancel_membership']);
  check('capability block: tools on -> cancelling is no longer "for the team"',
    [/cancelling or pausing a membership/.test(promptBuilder.capabilityBlock({ membershipTools: true })), /refunds, billing questions/.test(promptBuilder.capabilityBlock({ membershipTools: true }))], [false, true]);
  check('capability block: tools off -> it still is', /cancelling or pausing a membership/.test(promptBuilder.capabilityBlock()), true);
  config.membership.enabled = false;
  check('switch off: no tools, no block, and a call is refused',
    [membership.definitionsFor(someone.id).length, membership.promptBlock(someone.id), (await tool('cancel_membership', someone.id)).error], [0, '', 'Unknown tool: cancel_membership']);
  config.membership.enabled = true;
  check('RESUME is understood in several forms', ['RESUME', 'please reactivate me', "I'm back", 'resume my membership'].map((t) => membership.RESUME_REQUEST.test(t)), [true, true, true, true]);
  check('ordinary words are not a resume request', ['thanks', 'ok', 'what does that mean?'].map((t) => membership.RESUME_REQUEST.test(t)), [false, false, false]);

  // ------------------------------------------------------------------ offer first
  console.log('\nOFFER FIRST');
  const eve = await addMember({ first: 'Eve' });
  const eveSub = giveStripe(eve);
  let r = await tool('cancel_membership', eve.id);
  check('cancel without the offer is refused', [r.ok, r.error], [false, 'offer_first']);
  check('and Alice is handed the offer to send instead', /cover your next 30 days/.test(r.say), true);
  check('nothing changed: status, Stripe, tasks', [(await userRow(eve.id)).account_status, stripeCalls.length, await lastTask(eve.id)], ['Active', 0, undefined]);
  r = await tool('pause_membership', eve.id, { days: 30 });
  check('pause without the offer is refused too', r.error, 'offer_first');
  r = await tool('apply_free_month', eve.id);
  check('and the free month', r.error, 'offer_first');

  r = await tool('retention_offer', eve.id);
  check('the offer: her name and the three options', [r.ok, /^I completely understand, Eve,/.test(r.say), /free/.test(r.say), /pause your membership for 30 or 60 days/.test(r.say), /permanent cancellation/.test(r.say)],
    [true, true, true, true, true]);
  check('the offer is recorded', await eventCount(eve.id, 'retention_offer_made'), 1);

  // ------------------------------------------------------------------ free month
  console.log('\nPATH 1: FREE MONTH');
  r = await tool('apply_free_month', eve.id);
  check('applied', [r.ok, r.stripe], [true, 'done']);
  check('Stripe: the trial ends 30 days later, no proration', stripeCalls[0], { op: 'update', id: eveSub, params: { trial_end: 1_800_000_000 + 30 * 86400, proration_behavior: 'none' } });
  let row = await userRow(eve.id);
  check('still Active, trial 30 days longer, marked as used', [row.account_status, row.onboarding_phase, row.trial_duration_days, Boolean(row.free_month_applied_at)], ['Active', 'Active', 210, true]);
  check('the Stripe ids are remembered', [row.stripe_customer_id, row.stripe_subscription_id], [`cus_${eve.client_id}`, eveSub]);
  check('Alice says it is done', /I've applied your complimentary month/.test(r.say), true);
  let task = await lastTask(eve.id);
  check('desk task: retention note, nothing to do', [/Retention: 1 month free applied/.test(task.ai_summary), /Stripe: done/.test(task.ai_summary), task.requires_human], [true, true, false]);
  check('logged in automation_logs as the brief names it',
    (await db.query(`SELECT status::text AS s FROM automation_logs WHERE user_id = $1 AND automation_type = 'retention_free_month_applied'`, [eve.id])).rows[0]?.s, 'success');
  r = await tool('apply_free_month', eve.id);
  check('a second free month is refused, Stripe untouched', [r.ok, r.error, stripeCalls.length], [false, 'already_applied', 1]);

  const paid = await addMember({ first: 'Paid' });
  const paidSub = giveStripe(paid, 'active', { trial_end: null });
  await tool('retention_offer', paid.id);
  stripeCalls.length = 0;
  r = await tool('apply_free_month', paid.id);
  check('past the trial with no coupon set: not claimed as done', [r.ok, r.stripe, /team will confirm the billing adjustment/.test(r.say), stripeCalls.length], [true, 'manual', true, 0]);
  task = await lastTask(paid.id);
  check('the desk is told billing needs a hand', [/STRIPE WAS NOT CHANGED/.test(task.ai_summary), /STRIPE_FREE_MONTH_COUPON_ID/.test(task.ai_summary), task.requires_human, task.priority], [true, true, true, 'high']);
  const paid2 = await addMember({ first: 'Paid2' });
  const paid2Sub = giveStripe(paid2, 'active', { trial_end: null });
  config.membership.freeMonthCouponId = 'FREE30';
  await tool('retention_offer', paid2.id);
  r = await tool('apply_free_month', paid2.id);
  check('with a coupon set: the coupon is applied', [r.stripe, stripeCalls[0]], ['done', { op: 'update', id: paid2Sub, params: { discounts: [{ coupon: 'FREE30' }] } }]);
  config.membership.freeMonthCouponId = null;
  void paidSub;

  // ------------------------------------------------------------------ pause
  console.log('\nPATH 2: PAUSE');
  const pam = await addMember({ first: 'Pam' });
  const pamSub = giveStripe(pam);
  await tool('retention_offer', pam.id);
  stripeCalls.length = 0;
  r = await tool('pause_membership', pam.id, { days: 60 });
  check('paused', [r.ok, r.stripe], [true, 'done']);
  const resumesAt = stripeCalls[0].params.pause_collection.resumes_at;
  check('Stripe: collection paused (void) until 60 days from now',
    [stripeCalls[0].op, stripeCalls[0].id, stripeCalls[0].params.pause_collection.behavior, Math.abs(resumesAt - (Date.now() / 1000 + 60 * 86400)) < 60], ['update', pamSub, 'void', true]);
  row = await userRow(pam.id);
  check('status Paused; Airtable status Inactive', [row.account_status, row.onboarding_phase], ['Paused', 'Inactive']);
  check('proactive messages off, automations kept for later', [row.active_automations, row.paused_automations], [[], ['date_night', 'gifting']]);
  check('pause end stored', Math.abs(new Date(row.membership_paused_until).getTime() - (Date.now() + 60 * 86400e3)) < 60e3, true);
  check('Alice says 60 days and how to come back', [/safely paused for 60 days/.test(r.say), /simply send me a message here/.test(r.say)], [true, true]);
  task = await lastTask(pam.id);
  check('desk task as the brief words it', /Self-paused for 60 days via WhatsApp/.test(task.ai_summary), true);

  twilioSends.length = 0;
  r = await whatsapp({ From: pam.phone_number, Body: 'Thank you!', MessageSid: 'SMp1' });
  check('a paused member writes: told how to come back, not sent to Alice', [/Your membership is paused until/.test(twilioSends[0]?.body || ''), /Reply RESUME/.test(twilioSends[0]?.body || '')], [true, true]);
  check('"thank you" did not reactivate her', (await userRow(pam.id)).account_status, 'Paused');
  stripeCalls.length = 0;
  twilioSends.length = 0;
  await whatsapp({ From: pam.phone_number, Body: 'Resume please', MessageSid: 'SMp2' });
  row = await userRow(pam.id);
  check('RESUME: Active again, automations back, pause cleared',
    [row.account_status, row.onboarding_phase, row.active_automations, row.paused_automations, row.membership_paused_until], ['Active', 'Active', ['date_night', 'gifting'], null, null]);
  check('Stripe: collection resumed', stripeCalls[0], { op: 'update', id: pamSub, params: { pause_collection: '' } });
  check('she is welcomed back', /^Welcome back, Pam\./.test(twilioSends[0]?.body || ''), true);

  await tool('retention_offer', pam.id);
  r = await tool('pause_membership', pam.id, { days: 45 });
  check('an odd number of days becomes 30', /safely paused for 30 days/.test(r.say), true);
  check('nothing due: the auto-resume job stays quiet', await membership.runAutoResume(), undefined);
  check('and the lifecycle job reports nothing', JSON.stringify(await lifecycleJob.runOnce()), '{}');
  await db.query(`UPDATE users SET membership_paused_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [pam.id]);
  const auto = await membership.runAutoResume();
  check('the pause ran out: reactivated by the job', [auto, (await userRow(pam.id)).account_status], [{ due: 1, resumed: 1 }, 'Active']);
  check('the desk hears about it', /Pause ended: reactivated automatically/.test((await lastTask(pam.id)).ai_summary), true);

  // ------------------------------------------------------------------ cancel
  console.log('\nPATH 3: CANCEL');
  const cal = await addMember({ first: 'Cal' });
  const calSub = giveStripe(cal);
  await tool('retention_offer', cal.id);
  stripeCalls.length = 0;
  r = await tool('cancel_membership', cal.id);
  check('cancelled', [r.ok, r.stripe], [true, 'done']);
  check('Stripe: the subscription is cancelled', stripeCalls, [{ op: 'cancel', id: calSub }]);
  row = await userRow(cal.id);
  check('status Cancelled, automations off, handed to the desk', [row.account_status, row.onboarding_phase, row.active_automations, row.conversation_mode], ['Cancelled', 'Inactive', [], 'human']);
  check('Alice says the subscription was cancelled', /your Stripe subscription has been cancelled/.test(r.say), true);
  const cancelEvent = (await db.query(`SELECT metadata FROM events WHERE user_id = $1 AND event_name = 'membership_cancelled'`, [cal.id])).rows[0];
  check('the brief\'s summary tag is recorded', /^\[AI_SUMMARY: Account Cancellation - Client ID: Ai-MB\d+ - Permanent opt-out requested\. Stripe subscription terminated\.\]$/.test(cancelEvent.metadata.summary), true);
  check('desk task', /Account cancellation/.test((await lastTask(cal.id)).ai_summary), true);
  check('a cancelled member is not treated as paused', await membership.handlePausedMessage(cal, 'resume', {}), null);

  // ------------------------------------------------------------------ Stripe cannot be changed
  console.log('\nWHEN STRIPE CANNOT BE CHANGED');
  const noStripe = await addMember({ first: 'NoStripe' });
  await tool('retention_offer', noStripe.id);
  stripeCalls.length = 0;
  r = await tool('cancel_membership', noStripe.id);
  check('no Stripe subscription: the account still closes', [r.ok, r.stripe, (await userRow(noStripe.id)).account_status], [true, 'manual', 'Cancelled']);
  check('Alice does NOT say Stripe was cancelled', [/Stripe subscription has been cancelled/.test(r.say), /team will confirm the cancellation of your billing/.test(r.say)], [false, true]);
  task = await lastTask(noStripe.id);
  check('the desk task says so in capitals', [/STRIPE WAS NOT CHANGED: no live Stripe subscription was found/.test(task.ai_summary), /DO IT BY HAND/.test(task.ai_summary), task.requires_human], [true, true, true]);

  const twin = await addMember({ first: 'Twin', email: 'twin@example.com' });
  customers.push({ id: 'cus_twin_a', email: 'twin@example.com' }, { id: 'cus_twin_b', email: 'twin@example.com' });
  await tool('retention_offer', twin.id);
  r = await tool('pause_membership', twin.id, { days: 30 });
  check('two Stripe customers with one email: no guessing', [r.stripe, /more than one Stripe customer/.test((await lastTask(twin.id)).ai_summary), stripeCalls.length], ['manual', true, 0]);

  const locked = await addMember({ first: 'Locked' });
  giveStripe(locked);
  await tool('retention_offer', locked.id);
  stripeRefuses = true;
  r = await tool('pause_membership', locked.id, { days: 30 });
  stripeRefuses = false;
  check('a key that may not change subscriptions: paused here, billing to the desk',
    [r.ok, r.stripe, (await userRow(locked.id)).account_status, /Stripe refused the change/.test((await lastTask(locked.id)).ai_summary)], [true, 'manual', 'Paused', true]);
  check('and Alice says the team confirms the billing pause', /team will confirm the billing pause/.test(r.say), true);

  const late = await addMember({ first: 'Late' });
  await tool('retention_offer', late.id);
  await db.query(`UPDATE events SET timestamp = NOW() - INTERVAL '49 hours' WHERE user_id = $1 AND event_name = 'retention_offer_made'`, [late.id]);
  r = await tool('cancel_membership', late.id);
  check('an offer from 49 hours ago no longer counts', [r.error, (await userRow(late.id)).account_status], ['offer_first', 'Active']);

  const checkout = await addMember({ first: 'Checkout' });
  await membership.rememberStripeIds(checkout.id, { customer: 'cus_checkout', subscription: { id: 'sub_checkout' } });
  row = await userRow(checkout.id);
  check('a finished checkout stores the Stripe ids', [row.stripe_customer_id, row.stripe_subscription_id], ['cus_checkout', 'sub_checkout']);

  // ------------------------------------------------------------------ feedback loop
  console.log('\nVOICE-NOTE FEEDBACK LOOP');
  const fb = await addMember({ first: 'Alex', activatedDaysAgo: 15 });
  const early = await addMember({ first: 'Early', activatedDaysAgo: 3 });
  const old = await addMember({ first: 'Old', activatedDaysAgo: 60 });
  await messages.inbound(fb.id, 'hello', {});
  twilioSends.length = 0;
  let run = await feedback.runRequests();
  check('day 15, wrote today: the request goes out (plain text inside the window)', [run.due, run.sent], [1, 1]);
  check('the brief\'s words, with the name', [/^Alex, as one of our founding members/.test(twilioSends[0]?.body || ''), /voice note/.test(twilioSends[0]?.body || ''), /brutal honesty/.test(twilioSends[0]?.body || '')], [true, true, true]);
  check('stamped, so it is asked once', Boolean((await userRow(fb.id)).feedback_requested_at), true);
  run = await feedback.runRequests();
  check('second run: nobody due', [run.due, run.sent], [0, 0]);
  check('day 3 and day 60 are outside the 14-to-21-day slot', [(await userRow(early.id)).feedback_requested_at, (await userRow(old.id)).feedback_requested_at], [null, null]);
  run = await feedback.runRequests(undefined, { userId: early.id, ignoreWait: true });
  check('no approved template and the client is outside 24 hours: not sent, tried again later', [run.due, run.sent, run.skipped, (await userRow(early.id)).feedback_requested_at], [1, 0, 1, null]);

  check('a typed message is not feedback', await feedback.maybeCapture(fb, 'Book me a table for Friday', {}), null);
  const cap = await feedback.maybeCapture(fb, `${messages.AUDIO_PREFIX} Onboarding was smooth. The date night reminder is the thing I use most. The calendar login was confusing.`, { requestId: 'req-fb' });
  check('a voice note in the week after the request is captured', [Boolean(cap?.feedback_id), /answer to your request for feedback/.test(cap?.contextNote || '')], [true, true]);
  const stored = (await db.query('SELECT source, content FROM client_feedback WHERE user_id = $1', [fb.id])).rows;
  check('stored in the client\'s own words, without the marker', [stored.length, stored[0].source, stored[0].content.startsWith('Onboarding was smooth.')], [1, 'voice_note', true]);
  task = await lastTask(fb.id);
  check('on the desk board as a note, not a job', [/^FEEDBACK \(voice note\) from Alex Test:/.test(task.ai_summary), task.requires_human], [true, false]);
  check('a second voice note is an ordinary message', await feedback.maybeCapture(fb, `${messages.AUDIO_PREFIX} Also book me a car for Monday.`, {}), null);
  await db.query(`UPDATE users SET feedback_requested_at = NOW() - INTERVAL '9 days' WHERE id = $1`, [old.id]);
  check('a voice note nine days after the request is not feedback', await feedback.maybeCapture(old, `${messages.AUDIO_PREFIX} Hello.`, {}), null);
  r = await call('/admin/feedback', { headers: AUTH });
  check('the feedback can be read back', [r.status, r.body.count, r.body.feedback[0].first_name], [200, 1, 'Alex']);
  check('feedback request switch is off by default', config.feedback.enabled, false);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.pool.end();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FAILED:', err.message, '\n', err.stack);
  process.exit(1);
});
