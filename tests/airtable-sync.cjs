/**
 * What the backend sends to the client's Airtable: field names must match
 * the real Tasks table, or Airtable rejects the whole row.
 *
 *   node tests/airtable-sync.cjs        (no database needed; Airtable is stubbed)
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.AIRTABLE_API_KEY = 'pat_test_fake';
process.env.AIRTABLE_BASE_ID = 'appTEST';
process.env.AIRTABLE_TABLE_NAME = 'Clients';
for (const k of ['AIRTABLE_TASKS_TABLE_NAME', 'AIRTABLE_TASKS_TABLE_ID', 'AIRTABLE_TASKS_USER_LINK_FIELD']) delete process.env[k];

const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const isSearch = (opts.method || 'GET') === 'GET';
  return new Response(JSON.stringify(isSearch ? { records: [] } : { id: 'recNEW1' }), { status: 200 });
};

const airtable = require('../src/integrations/airtable');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

(async () => {
  console.log('\nTASK -> AIRTABLE TASKS TABLE');
  const id = await airtable.syncTask({
    task_id: 'b2f1c0de-0000-4000-8000-000000000001',
    ai_summary: 'Dinner at Zuma DIFC, Friday 20:00, 2 guests.',
    source_message: 'Zuma DIFC',
    status: 'new', priority: 'high', category: 'date_night',
    assigned_to: 'assist@ailifeconcierge.co.uk', requires_human: true,
  }, 'recCLIENT1');

  const post = calls.find((c) => c.method === 'POST');
  const f = post?.body?.fields || {};
  check('created a row', id, 'recNEW1');
  check('in the Tasks table by default', decodeURIComponent(post?.url || '').endsWith('/Tasks'), true);
  check('summary goes to "AI Summary"', f['AI Summary'], 'Dinner at Zuma DIFC, Friday 20:00, 2 guests.');
  check('no field called "Summary"', 'Summary' in f, false);
  check('client linked via "Requesting Client"', JSON.stringify(f['Requesting Client']), JSON.stringify(['recCLIENT1']));
  check('no "User" field', 'User' in f, false);
  check('email not put in the "Assigned To" link field', 'Assigned To' in f, false);
  check('Requires Human ticked', f['Requires Human'], true);
  check('new select options allowed (typecast)', post?.body?.typecast, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
