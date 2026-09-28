/**
 * Message batching tests.
 *
 *   TEST_DATABASE_URL=postgres://... node tests/batching.cjs
 *
 * DESTROYS the public schema of the target database. Throwaway only.
 *
 * The agent is stubbed. What matters here is that a burst becomes ONE turn
 * with the full text, not what the agent then says about it.
 */

process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.BATCH_QUIET_MS = '600';   // keep the test quick
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const batcher = require('../src/services/messageBatcher');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(read('init-db.sql'));
  await db.query(read('db', 'sql', '001a_prepare.sql'));
  await db.query(read('db', 'sql', '001b_finalize.sql'));
  await db.query(read('db', 'sql', '003_timezone_and_tokens.sql'));
  await db.query(read('db', 'sql', '004_message_batching.sql'));

  const { rows } = await db.query(
    `INSERT INTO users (first_name, phone_number) VALUES ('Burst','whatsapp:+447700900444') RETURNING id`);
  const userId = rows[0].id;

  // Records what the agent was handed, so we can assert on it.
  const seen = [];
  const stubFlow = async (user, text) => { seen.push(text); return `ack: ${text.length} chars`; };

  console.log('\nA BURST OF THREE MESSAGES');
  await batcher.enqueue({ userId, messageSid: 'SM1', body: "I'm in Dubai", fromNumber: 'whatsapp:+447700900444', requestId: 'r1' });
  await sleep(100);
  await batcher.enqueue({ userId, messageSid: 'SM2', body: 'this week', fromNumber: 'whatsapp:+447700900444', requestId: 'r2' });
  await sleep(100);
  await batcher.enqueue({ userId, messageSid: 'SM3', body: 'find me dinner Thursday', fromNumber: 'whatsapp:+447700900444', requestId: 'r3' });

  const queued = await db.query("SELECT COUNT(*)::int n FROM pending_messages WHERE state='pending'");
  check('all three are queued', queued.rows[0].n, 3);

  // Still typing: nothing should be claimed yet.
  check('nothing runs while they are still typing', await batcher.processNextBatch(stubFlow), false);
  check('the agent has not been called', seen.length, 0);

  console.log('\nAFTER THEY STOP TYPING');
  await sleep(800);
  check('one batch is processed', await batcher.processNextBatch(stubFlow), true);
  check('the agent ran exactly ONCE', seen.length, 1);
  check('it received all three messages', seen[0], "I'm in Dubai\nthis week\nfind me dinner Thursday");
  check('nothing else is waiting', await batcher.processNextBatch(stubFlow), false);
  check('the agent still ran only once', seen.length, 1);

  const done = await db.query("SELECT COUNT(*)::int n FROM pending_messages WHERE state='done'");
  check('all three are marked done', done.rows[0].n, 3);

  const ev = await db.query("SELECT metadata FROM events WHERE event_name='messages_batched'");
  check('a messages_batched event is recorded', ev.rowCount, 1);
  check('it records the count', ev.rows[0]?.metadata?.message_count, 3);

  console.log('\nDUPLICATE TWILIO RETRY');
  const first = await batcher.enqueue({ userId, messageSid: 'SM9', body: 'hello', fromNumber: 'whatsapp:+447700900444', requestId: 'r9' });
  const retry = await batcher.enqueue({ userId, messageSid: 'SM9', body: 'hello', fromNumber: 'whatsapp:+447700900444', requestId: 'r9' });
  check('the first is accepted', first, true);
  check('the retry is ignored', retry, false);
  const dupes = await db.query("SELECT COUNT(*)::int n FROM pending_messages WHERE message_sid='SM9'");
  check('only one row exists', dupes.rows[0].n, 1);

  await sleep(800);
  await batcher.processNextBatch(stubFlow);
  check('the retry did not cause a second reply', seen.length, 2);

  console.log('\nA SINGLE MESSAGE STILL WORKS');
  await batcher.enqueue({ userId, messageSid: 'SM10', body: 'just one', fromNumber: 'whatsapp:+447700900444', requestId: 'r10' });
  await sleep(800);
  await batcher.processNextBatch(stubFlow);
  check('it reaches the agent as-is', seen[2], 'just one');
  const singleEv = await db.query("SELECT COUNT(*)::int n FROM events WHERE event_name='messages_batched'");
  check('a single message is not reported as a batch', singleEv.rows[0].n, 1);

  console.log('\nA FAILING BATCH IS RETRIED, THEN PARKED');
  const boom = async () => { throw new Error('agent exploded'); };
  await batcher.enqueue({ userId, messageSid: 'SM11', body: 'breaks', fromNumber: 'whatsapp:+447700900444', requestId: 'r11' });
  await sleep(800);
  for (let i = 0; i < 4; i += 1) { await batcher.processNextBatch(boom); await sleep(50); }
  const parked = await db.query("SELECT state, attempts, last_error FROM pending_messages WHERE message_sid='SM11'");
  check('it ends up parked as failed', parked.rows[0].state, 'failed');
  check('the error is recorded', parked.rows[0].last_error, 'agent exploded');
  check('it is not retried forever', parked.rows[0].attempts <= 3, true);

  console.log('\nHISTORY IS NOT POLLUTED');
  const conv = await db.query('SELECT COUNT(*)::int n FROM conversations');
  check('the stub wrote no conversation rows', conv.rows[0].n, 0);

  await db.pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nFAILED:', e.message, '\n', e.stack);
  process.exit(1);
});
