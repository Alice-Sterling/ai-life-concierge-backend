/**
 * Pure-function checks for the agent tools, Flow 2 / Flow 3 and the calendar
 * mapping. No database: safe to run anywhere.
 *
 *   node tests/flows-unit.cjs
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/none';
process.env.ADMIN_API_TOKEN = 'test-admin-token-12345';
delete process.env.AGENT_TOOLS_ENABLED;

const { config } = require('../src/config');
const flows = require('../src/services/proactiveFlows');
const calendar = require('../src/services/calendar');
const templates = require('../src/services/templates');
const agentTools = require('../src/services/agentTools');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

console.log('\nMILESTONE DETECTION');
check("Mum's Birthday", flows.detectMilestone("Mum's Birthday"), 'birthday');
check('bday', flows.detectMilestone('Sam bday drinks'), 'birthday');
check('Anniversary', flows.detectMilestone('Our anniversary'), 'anniversary');
check('wedding', flows.detectMilestone("Tom & Ana's wedding"), 'wedding');
check('engagement party', flows.detectMilestone('Engagement party'), 'engagement');
check('ordinary meeting -> none', flows.detectMilestone('Board meeting'), null);
check('"birthdays" in a word is not "bday"', flows.detectMilestone('Daybreak run'), null);
check('empty -> none', flows.detectMilestone(''), null);

console.log('\nLOCAL DAY AND HOUR');
const sun18London = new Date('2026-10-25T18:30:00Z'); // GMT after 25 Oct clock change
check('Sun 18:30 London', flows.localDayHour('Europe/London', sun18London), { day: 0, hour: 18 });
check('same instant in Dubai is Sun 22', flows.localDayHour('Asia/Dubai', sun18London), { day: 0, hour: 22 });
check('bad timezone falls back to London', flows.localDayHour('Nope/Nope', sun18London), { day: 0, hour: 18 });

console.log('\nEVENT KEY (no title leak)');
const ev = { title: "Mum's Birthday", start: '2026-11-15' };
check('stable', flows.eventKey(ev), flows.eventKey({ ...ev }));
check('different date -> different key', flows.eventKey(ev) === flows.eventKey({ ...ev, start: '2027-11-15' }), false);
check('title not in the key', flows.eventKey(ev).includes('Mum'), false);

console.log('\nCALENDAR MAPPING');
const gFree = { summary: "Mum's Birthday", start: { date: '2026-11-15' }, end: { date: '2026-11-16' }, transparency: 'transparent', location: 'Bath' };
const gBusy = { summary: 'Dinner', start: { dateTime: '2026-11-15T19:00:00Z' }, end: { dateTime: '2026-11-15T21:00:00Z' }, location: 'Soho' };
check('default: free event left out (as before)', calendar.mapGoogleEvent(gFree), null);
check('default: busy event has no location', 'location' in calendar.mapGoogleEvent(gBusy), false);
check('includeFree: free event kept and marked', calendar.mapGoogleEvent(gFree, { includeFree: true }).free, true);
check('withLocation adds the location', calendar.mapGoogleEvent(gBusy, { withLocation: true }).location, 'Soho');
check('cancelled always out', calendar.mapGoogleEvent({ ...gBusy, status: 'cancelled' }, { includeFree: true }), null);
const oFree = { subject: 'Anniversary', start: { dateTime: '2026-11-20T00:00:00.0000000' }, end: { dateTime: '2026-11-21T00:00:00.0000000' }, showAs: 'free', isAllDay: true, location: { displayName: 'Home' } };
check('Outlook default: free left out', calendar.mapOutlookEvent(oFree), null);
check('Outlook includeFree: kept, all-day', calendar.mapOutlookEvent(oFree, { includeFree: true }).all_day, true);
check('Outlook UTC suffix', calendar.mapOutlookEvent(oFree, { includeFree: true }).start, '2026-11-20T00:00:00.0000000Z');
check('Outlook location', calendar.mapOutlookEvent(oFree, { includeFree: true, withLocation: true }).location, 'Home');

console.log('\nTEMPLATES');
const u = { first_name: 'Tim' };
check('weekly briefing variables', templates.TEMPLATES.weekly_briefing.variables(u), { 1: 'Tim' });
check('milestone uses {{9}} (as approved)', templates.TEMPLATES.milestone_ping.variables(u, { eventType: 'birthday' }), { 1: 'Tim', 9: 'birthday' });
check('milestone text names the occasion', /a birthday coming up/.test(templates.TEMPLATES.milestone_ping.text(u, { eventType: 'birthday' })), true);
check('date night keeps {{16}}/{{17}}', Object.keys(templates.TEMPLATES.datenight_ping.variables({ ...u, date_night_cadence: 7 })), ['1', '16', '17']);
check('weekly SID default (approved one)', config.templates.weekly_briefing, 'HX99dd6899b50bf20afd3ea632e69db152');
check('milestone SID default (approved one)', config.templates.milestone_ping, 'HXd081fba8e431f93bf9229b86919cf32d');

console.log('\nSWITCHES OFF BY DEFAULT');
check('weekly briefing off', config.lifecycle.weeklyBriefing, false);
check('milestone ping off', config.lifecycle.milestonePing, false);
check('agent tools off', config.agentTools.enabled, false);
check('Sunday 18:00 by default', [config.lifecycle.weeklyBriefingDay, config.lifecycle.weeklyBriefingHour], [0, 18]);
check('21 days ahead by default', config.lifecycle.milestoneDaysAhead, 21);

console.log('\nAGENT TOOLS');
const stranger = '00000000-0000-4000-8000-000000000000';
const tester = config.testTools.userIds[0];
check('client: no tools while off', agentTools.definitionsFor(stranger).length, 0);
check('client: no prompt block while off', agentTools.promptBlock(stranger), '');
check('test account: both tools', agentTools.definitionsFor(tester).map((t) => t.name), ['queue_local_dispatch', 'submit_private_inquiry']);
check('test account: routing block', /submit_private_inquiry/.test(agentTools.promptBlock(tester)), true);
config.agentTools.enabled = true;
check('switched on: everyone gets them', agentTools.definitionsFor(stranger).length, 2);
config.agentTools.enabled = false;
check('has() knows the tools', [agentTools.has('queue_local_dispatch'), agentTools.has('handoff_to_concierge')], [true, false]);
const cv = JSON.parse(agentTools.cannotVerify('down'));
check('cannotVerify tells Alice to hand off', [cv.verified, /handoff_to_concierge/.test(cv.instruction)], [false, true]);
for (const t of agentTools.TOOLS) {
  check(`${t.name}: schema has required fields`, t.input_schema.required.every((r) => r in t.input_schema.properties), true);
}

(async () => {
  // ---- Calendar connect + trial marking, with a fake database and Airtable
  const db = require('../src/db/pool');
  const airtable = require('../src/integrations/airtable');
  const gateway = require('../src/services/gateway');
  const lifecycle = require('../src/services/lifecycle');
  const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };

  let world;
  db.query = async (sql, params) => {
    world.sql.push(sql);
    if (/client_id = \$1::varchar OR short_id/.test(sql)) return { rows: world.byId ? [world.byId] : [] };
    if (/regexp_replace\(phone_number/.test(sql)) { world.phoneAsked = params[0]; return { rows: world.byPhone ? [world.byPhone] : [] }; }
    if (/UPDATE users SET short_id/.test(sql)) { world.linked = params[1]; return { rows: [] }; }
    return { rows: [] };
  };
  airtable.isConfigured = () => true;
  airtable.findUserRecord = async ({ clientId }) => {
    const ids = [].concat(clientId || []);
    return world.records.find((r) => ids.includes(r.fields['Client ID'])) || null;
  };
  airtable.updateUserRecord = async (id, fields) => { world.patched = { id, fields }; return true; };
  gateway.adoptFromAirtable = async (phone) => { world.adopted = phone; return { id: 'new-user' }; };
  const fresh = (over = {}) => ({ sql: [], records: [], byId: null, byPhone: null, ...over });

  console.log('\nCALENDAR CONNECT: FIND, LINK OR CREATE');
  world = fresh({ byId: { id: 'u1' } });
  check('known Client ID -> that user', (await lifecycle.findOrAdoptClient('Ai-WEB1', silent))?.id, 'u1');

  world = fresh({ records: [{ id: 'rec1', fields: { 'Client ID': 'Ai-WEB2', phone_number: '07987 777888' } }],
    byPhone: { id: 'u2', short_id: 'Ai-OLD2', client_id: 'Ai-OLD2' } });
  let found = await lifecycle.findOrAdoptClient('Ai-WEB2', silent);
  check('unknown id -> Airtable phone -> user', found?.id, 'u2');
  check('phone matched on digits, UK form', world.phoneAsked, ['447987777888', '07987777888']);
  check('linked to the website id', world.linked, 'Ai-WEB2');

  world = fresh({ records: [
    { id: 'rec3', fields: { 'Client ID': 'Ai-WEB3', phone_number: '07359259528' } },
    { id: 'rec4', fields: { 'Client ID': 'Ai-OTHER', phone_number: '07359259528' } }],
  byPhone: { id: 'u3', short_id: 'Ai-OTHER', client_id: 'Ai-OTHER' } });
  found = await lifecycle.findOrAdoptClient('Ai-WEB3', silent);
  check('duplicate rows for one phone -> same user', found?.id, 'u3');
  check('... but the link is not flipped', world.linked, undefined);

  world = fresh({ records: [{ id: 'rec5', fields: { 'Client ID': 'Ai-WEB5', phone_number: '+44 7700 900555' } }] });
  found = await lifecycle.findOrAdoptClient('Ai-WEB5', silent);
  check('nobody with that phone -> created from Airtable', found?.id, 'new-user');
  check('created with a WhatsApp number', world.adopted, 'whatsapp:+447700900555');

  world = fresh();
  check('unknown everywhere -> null (404)', await lifecycle.findOrAdoptClient('Ai-NOBODY', silent), null);

  console.log('\nACTIVATION MARKS "TRIAL STARTED"');
  world = fresh({ records: [{ id: 'rec6', fields: { 'Client ID': 'Ai-T1' } }] });
  await lifecycle.markTrialStarted({ id: 'u6', short_id: 'Ai-T1' }, silent);
  check('empty Stripe Status -> Trial Started', world.patched, { id: 'rec6', fields: { 'Stripe Status': 'Trial Started' } });
  world = fresh({ records: [{ id: 'rec7', fields: { 'Client ID': 'Ai-T2', 'Stripe Status': 'Trial Ended' } }] });
  await lifecycle.markTrialStarted({ id: 'u7', short_id: 'Ai-T2' }, silent);
  check('existing value left alone', world.patched, undefined);
  world = fresh();
  check('no Airtable row -> nothing', await lifecycle.markTrialStarted({ id: 'u8', short_id: 'Ai-T3' }, silent), false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
