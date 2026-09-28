// Point at a THROWAWAY database. This script drops and recreates the public
// schema on every run, so never aim it at anything you care about.
process.env.DATABASE_URL = process.env.SB_URL || process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. This script DESTROYS all data in it.');
  process.exit(1);
}
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const { createApp } = require('../src/app');
const db = require('../src/db/pool');

const app = createApp();
let server, base;

const call = async (path, opts = {}) => {
  const res = await fetch(base + path, opts);
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body, reqId: res.headers.get('x-request-id') };
};
const AUTH = { Authorization: 'Bearer test-admin-token-12345' };
const show = (label, r) => console.log(`  ${String(r.status).padEnd(3)} ${label}`);

(async () => {
  // Rebuild the sandbox so this run is reproducible.
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(fs.readFileSync(require('path').join(__dirname,'..','init-db.sql'), 'utf8'));
  await db.query(fs.readFileSync(require('path').join(__dirname,'..','db','sql','001a_prepare.sql'),'utf8'));
  await db.query(fs.readFileSync(require('path').join(__dirname,'..','db','sql','001b_finalize.sql'),'utf8'));
  await db.query(fs.readFileSync(require('path').join(__dirname,'..','db','sql','003_timezone_and_tokens.sql'),'utf8'));
  await db.query(fs.readFileSync(require('path').join(__dirname,'..','db','sql','004_message_batching.sql'),'utf8'));
  const { rows } = await db.query(
    `INSERT INTO users (first_name, last_name, phone_number, client_id, onboarding_status, onboarding_step)
     VALUES ('Ada','Lovelace','+447700900123','CID-001','complete',8) RETURNING id`);
  const userId = rows[0].id;
  await db.query(`INSERT INTO conversations (user_id, message_body, ai_response)
                  VALUES ($1,'Book me dinner Friday','Of course. Any preference?')`, [userId]);

  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nHEALTH');
  show('GET /health', await call('/health'));

  console.log('\nPORTAL REDIRECT');
  const rd = await fetch(base + '/portal', { redirect: 'manual' });
  console.log(`  ${rd.status} GET /portal -> ${rd.headers.get('location')} ${rd.status === 301 ? '(301 permanent, correct)' : '(WRONG)'}`);

  console.log('\nADMIN AUTH');
  show('GET /admin/users  no token   (want 401)', await call('/admin/users'));
  show('GET /admin/users  bad token  (want 401)', await call('/admin/users', { headers: { Authorization: 'Bearer wrong' } }));

  console.log('\nADMIN ENDPOINTS (valid token)');
  const u = await call('/admin/users', { headers: AUTH });
  show('GET /admin/users', u);
  console.log('      ->', u.body.count, 'user(s); phase:', JSON.stringify(u.body.users?.[0]?.onboarding_phase), 'mode:', u.body.users?.[0]?.conversation_mode);

  show('GET /admin/tasks', await call('/admin/tasks', { headers: AUTH }));
  show('GET /admin/tasks?status=bogus (want 400)', await call('/admin/tasks?status=bogus', { headers: AUTH }));
  show('GET /admin/conversations/not-a-uuid (want 400)', await call('/admin/conversations/not-a-uuid', { headers: AUTH }));

  const c = await call(`/admin/conversations/${userId}`, { headers: AUTH });
  show('GET /admin/conversations/:id', c);
  console.log('      ->', c.body.count, 'message(s)');

  console.log('\nMODE TOGGLE');
  const m1 = await call(`/admin/users/${userId}/mode`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_mode: 'human' }) });
  show('POST mode=human', m1);
  console.log('      -> now:', m1.body.conversation_mode);

  const bad = await call(`/admin/users/${userId}/mode`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_mode: 'robot' }) });
  show('POST mode=robot (want 400)', bad);

  console.log('\nSIDE EFFECTS IN POSTGRES');
  const ev = await db.query("SELECT event_name, metadata FROM events ORDER BY event_id");
  console.log('      events recorded:', ev.rows.map(r => r.event_name).join(', ') || '(none)');

  console.log('\nTASK QUEUE');
  const tasks = require('../src/services/tasks');
  const t = await tasks.create({ userId, sourceMessage: 'Need a table at Park Chinois',
                                 aiSummary: 'VIP dinner request', priority: 'vip', category: 'date_night' });
  console.log('      created task', t.task_id.slice(0, 8), '| status', t.status);
  const done = await tasks.updateStatus(t.task_id, 'completed');
  console.log('      completed    | completed_at auto-set:', done.completed_at !== null);
  const tl = await call('/admin/tasks?status=completed', { headers: AUTH });
  show('GET /admin/tasks?status=completed', tl);
  console.log('      ->', tl.body.count, 'task(s)');

  console.log('\n404 + REQUEST ID');
  const nf = await call('/nope');
  show('GET /nope (want 404)', nf);
  console.log('      request_id echoed in header and body:', nf.reqId === nf.body.request_id);

  server.close();
  await db.pool.end();
  console.log('\nDone.');
})().catch(e => { console.error('\nFAILED:', e.message, '\n', e.stack); server?.close(); process.exit(1); });
