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
delete process.env.APIFY_TOKEN;

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
check('test account: all tools', agentTools.definitionsFor(tester).map((t) => t.name), [
  'queue_local_dispatch', 'submit_private_inquiry', 'check_dining_availability',
  'source_retail_gift', 'search_curated_experiences', 'search_local_events',
]);
check('test account: routing block', /submit_private_inquiry/.test(agentTools.promptBlock(tester)), true);
check('routing block: dining checked first', /check_dining_availability first/.test(agentTools.promptBlock(tester)), true);
check('routing block: copy link/phone/price on hand-off', /booking_link, vendor_phone and price/.test(agentTools.promptBlock(tester)), true);
config.agentTools.enabled = true;
check('switched on: everyone gets them', agentTools.definitionsFor(stranger).length, 6);
config.agentTools.enabled = false;
check('has() knows the tools', [agentTools.has('queue_local_dispatch'), agentTools.has('handoff_to_concierge')], [true, false]);
const cv = JSON.parse(agentTools.cannotVerify('down'));
check('cannotVerify tells Alice to hand off', [cv.verified, /handoff_to_concierge/.test(cv.instruction)], [false, true]);
for (const t of agentTools.TOOLS) {
  check(`${t.name}: schema has required fields`, t.input_schema.required.every((r) => r in t.input_schema.properties), true);
}

console.log('\nAPIFY RESULTS (shapes from the 31 Oct UK test runs)');
const apify = require('../src/integrations/apify');
const slot = (t, ok = true) => ({ dateTime: `2026-11-07T${t}`, available: ok, requiresCreditCard: true });
const bacchanalia = {
  name: 'Bacchanalia', url: 'https://www.opentable.com/restaurant/profile/285378', priceBand: '£41 and over',
  rating: 4.4, reviewCount: 2554, address: '1-3 Mount St', cuisines: ['Greek'],
  availabilitySlots: { slots: ['16:00', '18:30', '18:45', '21:15', '21:30', '22:30'].map((t) => slot(t)), noTimesReasons: [] },
};
const ot = agentTools.mapOpenTable(bacchanalia, '19:30');
check('OpenTable: only times within 90 min of 19:30', ot.available_times, ['18:30', '18:45']);
check('OpenTable: booking link kept', ot.booking_link, 'https://www.opentable.com/restaurant/profile/285378');
check('OpenTable: price band kept', ot.price, '£41 and over');
check('OpenTable: card flag', ot.card_required, true);
check('unavailable slot left out', agentTools.slotsNear([slot('19:30', false), slot('19:45')], '19:30'), ['19:45']);
const everyQuarter = ['18:00', '18:15', '18:30', '18:45', '19:00', '19:15', '19:30', '19:45', '20:00', '20:15', '20:30'].map((t) => slot(t));
check('closest 6 to 19:30, in time order', agentTools.slotsNear(everyQuarter, '19:30'), ['18:45', '19:00', '19:15', '19:30', '19:45', '20:00']);
check('GetYourGuide search URL', agentTools.gygSearchUrl('Edinburgh whisky tasting'), 'https://www.getyourguide.com/s/?q=Edinburgh%20whisky%20tasting');
check('tour link without tracking', agentTools.mapTour({ title: 'x', url: 'https://www.getyourguide.com/a-t1/?ranking_uuid=1&q=x' }).booking_link, 'https://www.getyourguide.com/a-t1/');
const fullyBooked = agentTools.mapOpenTable({ name: 'X', availabilitySlots: { slots: [], noTimesReasons: ['TooFarInAdvance'] } }, '19:30');
check('OpenTable: no slots -> empty + reason', [fullyBooked.available_times, fullyBooked.not_bookable_reason], [[], 'TooFarInAdvance']);
const gm = agentTools.mapGooglePlace({ title: 'Maiella Worth', phone: '+44 20 3685 4559', price: '£20–30', totalScore: 4.8, reserveTableUrl: 'https://www.google.com/maps/reserve/x', website: 'https://maiellaworth.com' });
check('Google Maps: phone + reservation link first', [gm.vendor_phone, gm.booking_link], ['+44 20 3685 4559', 'https://www.google.com/maps/reserve/x']);
check('Google Maps: website when no reservation link', agentTools.mapGooglePlace({ title: 'A', website: 'https://a.co.uk' }).booking_link, 'https://a.co.uk');
check('product shape', agentTools.mapProduct({ title: 'Grand Gesture Hat Box Roses', source: 'Haute Florist', price: '£170.00', link: 'https://g.co/x' }),
  { title: 'Grand Gesture Hat Box Roses', store: 'Haute Florist', price: '£170.00', booking_link: 'https://g.co/x' });
check('parseGbp', [agentTools.parseGbp('£1,170.50'), agentTools.parseGbp('n/a')], [1170.5, null]);
check('tour price in pounds', agentTools.mapTour({ title: 'Sky Garden', price: 13.5, currency: 'GBP', url: 'https://gyg/x', provider: 'GetYourGuide' }).price, '£13.5');
const evt = agentTools.mapEvent({ name: 'Art Club', url: 'https://www.eventbrite.co.uk/e/1', start_date: '2026-11-07', start_time: '10:00', primary_venue: { name: 'Paxton Centre', address: { city: 'London' } }, ticket_availability: { is_free: true } });
check('event shape', [evt.venue, evt.price, evt.time], ['Paxton Centre, London', 'Free', '10:00']);
check('Eventbrite city slug', [agentTools.eventbriteCity('London'), agentTools.eventbriteCity('New York', 'United States')], ['united-kingdom--london', 'united-states--new-york']);
check('apify: not configured without a token', apify.isConfigured(), Boolean(process.env.APIFY_TOKEN));
check('apify: every actor has a USD cap', Object.values(apify.ACTORS).every((a) => a.maxChargeUsd > 0 && a.maxChargeUsd <= 0.5), true);

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

  console.log('\nALARMS: LIKELY FIX');
  const alarms = require('../src/services/alarms');
  check('DB password', /redeploy the backend/.test(alarms.hintFor('password authentication failed for user "postgres"')), true);
  check('DB unreachable', /Postgres service/.test(alarms.hintFor('connect ETIMEDOUT fd12::413:5432')), true);
  check('Anthropic key', /ANTHROPIC_API_KEY/.test(alarms.hintFor('401 {"type":"authentication_error","message":"invalid x-api-key"}')), true);
  check('calendar expired', /reconnect their calendar/.test(alarms.hintFor('invalid_grant: Token has been expired or revoked')), true);
  check('unknown -> look up the request id', /request ID/.test(alarms.hintFor('something odd')), true);
  check('most common hint wins', /Postgres service/.test(alarms.bestHint(['ETIMEDOUT', 'ECONNREFUSED', 'weird'])), true);

  console.log('\nALARMS: REPORT');
  const q = [];
  db.query = async (sql, params) => {
    q.push(params);
    if (/webhook_failed/.test(sql)) return { rows: [{ timestamp: '2026-10-26T10:00:00Z', request_id: 'r1', error: 'password authentication failed', first_name: 'Sarah' }] };
    if (/last_error IS NOT NULL/.test(sql)) return { rows: [] };
    if (/received_at < NOW\(\) - INTERVAL '3 minutes'/.test(sql)) return { rows: [{ n: 2, oldest: '2026-10-26T09:50:00Z' }] };
    if (/FROM outbound_messages/.test(sql)) return { rows: [{ kind: 'reply', n: 3, last_at: 'x', error_code: null, error_message: null, last_client: 'Jon' }] };
    if (/FROM automation_logs/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const report = await alarms.collect({ sinceMinutes: '10' }, silent);
  check('report lists the problems found', report.issues.map((i) => i.key), ['webhook_failed', 'message_stuck', 'send_failed']);
  check('crash: critical, with the DB fix', [report.issues[0].severity, /redeploy/.test(report.issues[0].fix)], ['critical', true]);
  check('crash example has client and request id, no message text', report.issues[0].examples[0], { at: '2026-10-26T10:00:00Z', client: 'Sarah', request_id: 'r1', error: 'password authentication failed' });
  check('window passed to SQL', q[0], [10]);
  check('silly window clamped', (await alarms.collect({ sinceMinutes: 'abc' }, silent)).since_minutes, 6);
  db.query = async (sql) => ({ rows: /INTERVAL '3 minutes'/.test(sql) ? [{ n: 0, oldest: null }] : [] });
  check('all quiet -> no issues', (await alarms.collect({}, silent)).issues, []);

  console.log('\nTRIAL COUNTS FROM ACTIVATION');
  const legacy = require('../src/legacy/concierge');
  const daysAgo = (d) => new Date(Date.now() - d * 86400e3);
  // Tim's real shape: Airtable row from 14 Sep, account 26 Sep, activated 20 Oct.
  const tim = { trial_start_date: daysAgo(170), created_at: daysAgo(158), activated_at: daysAgo(6), subscription_status: 'FOUNDING_MEMBER' };
  check('anchor is the activation', legacy.trialAnchor(tim).getTime(), tim.activated_at.getTime());
  check('day count from activation', legacy.getFoundingMemberWindow(tim).daysSinceEnrollment, 6);
  const late = { ...tim, trial_start_date: daysAgo(200), activated_at: daysAgo(30) };
  check('old form date + recent activation -> still Founding Member', legacy.getSubscriptionStatusFromUser(late), 'FOUNDING_MEMBER');
  const ended = { ...tim, activated_at: daysAgo(181) };
  check('181 days after activation -> Lite', legacy.getSubscriptionStatusFromUser(ended), 'LITE');
  const never = { trial_start_date: daysAgo(10), created_at: daysAgo(20), activated_at: null, subscription_status: 'FOUNDING_MEMBER' };
  check('never activated -> old anchor kept', legacy.getFoundingMemberWindow(never).daysSinceEnrollment, 10);
  check('no dates at all -> no window', legacy.getFoundingMemberWindow({}).inWindow, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
