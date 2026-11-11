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

console.log('\nFRONT DOOR: ONBOARDED CLIENTS (Sarah, 1 Nov)');
const sarah = { first_name: 'Sarah', short_id: 'Ai-GQ6Ips4jB' };
const savedPay = config.gate.paymentUrl;
config.gate.paymentUrl = null;
check('no PAYMENT_URL: no "one final step" with nothing to tap', /final step is activating.*team will send you your secure link/.test(templates.TEMPLATES.pending_stripe.text(sarah)), true);
check('no PAYMENT_URL: follow-up says the team sends the link', /team will send your secure activation link/.test(templates.TEMPLATES.gate_followup.text(sarah, { status: 'Onboarded' })), true);
config.gate.paymentUrl = 'https://pay.ailifeconcierge.co.uk/b/cNi6oHbxs6KVe3e5a0dfG00';
check('with PAYMENT_URL: the link carries her client id', templates.TEMPLATES.pending_stripe.text(sarah).endsWith('cNi6oHbxs6KVe3e5a0dfG00?client_reference_id=Ai-GQ6Ips4jB'), true);
check('with PAYMENT_URL: follow-up repeats the link', /client_reference_id=Ai-GQ6Ips4jB/.test(templates.TEMPLATES.gate_followup.text(sarah, { status: 'Onboarded' })), true);
config.gate.paymentUrl = savedPay;
check('follow-up for Waitlist', /Founding Member list/.test(templates.TEMPLATES.gate_followup.text(sarah, { status: 'Waitlist' })), true);
check('follow-up is plain text (no template SID)', [templates.TEMPLATES.gate_followup.name, config.templates.gate_followup], [null, undefined]);

console.log('\nAIRTABLE -> BACKEND (11 Nov)');
const atSync = require('../src/services/airtableSync');
check('website automation labels -> backend slugs (Jonny\'s real row)', atSync.automationSlugs(
  'Regular Date Night Automation (monthly), Ad-hoc Client Event Automation, Proactive Milestone Proposals, '
  + 'Automated Flowers & Card Delivery (personal), Seamless Door-to-Door Coordination, Proactive Destination Experience Proposals'),
['date_night', 'gifting', 'travel_logistics']);
check('cadence from the label: monthly -> 30, none -> null',
  [atSync.cadenceFromLabels('Regular Date Night Automation (monthly), Proactive Milestone Proposals'), atSync.cadenceFromLabels('Proactive Milestone Proposals')], [30, null]);
const timRow = { 'First Name': 'Timotej Antos', Last_Name: 'Antoš', 'Conversation Mode': 'human ', 'Date Night Cadence': 0, 'Next Date Due': '2026-11-08', 'Home City': 'London', ActiveAutomations: 'Seamless Door-to-Door Coordination' };
const read = atSync.readFields(timRow);
check('Airtable row read: "human " -> human, cadence 0 = empty, profile fields', [read.conversation_mode, read.date_night_cadence, read.home_city, read.next_date_due, read.partner_name], ['human', null, 'London', '2026-11-08', null]);
const first = atSync.diff(read, {});
check('first look: every filled field applies', Object.keys(first.changes).sort(), ['automations', 'conversation_mode', 'first_name', 'home_city', 'last_name', 'next_date_due']);
const again = atSync.diff(read, first.seen);
check('same Airtable values again: nothing applies (a failed push is not undone)', Object.keys(again.changes), []);
const edited = atSync.diff({ ...read, home_city: 'Manchester', conversation_mode: 'ai' }, first.seen);
check('desk edits Home City + Conversation Mode: exactly those apply', edited.changes, { conversation_mode: 'ai', home_city: 'Manchester' });
check('an emptied Airtable cell does not wipe the backend', Object.keys(atSync.diff({ ...read, home_city: null }, first.seen).changes), []);
check('Airtable pull on by default', config.airtable.pullEnabled, true);

console.log('\nSWITCHES OFF BY DEFAULT');
check('weekly briefing off', config.lifecycle.weeklyBriefing, false);
check('milestone ping off', config.lifecycle.milestonePing, false);
check('agent tools off', config.agentTools.enabled, false);
check('Sunday 18:00 by default', [config.lifecycle.weeklyBriefingDay, config.lifecycle.weeklyBriefingHour], [0, 18]);
check('21 days ahead by default', config.lifecycle.milestoneDaysAhead, 21);
check('transit ping off, 10:00, 14 days ahead', [config.lifecycle.transitPing, config.lifecycle.transitPingHour, config.lifecycle.transitDaysAhead], [false, 10, 14]);

console.log('\nFLOW 4: FLIGHTS IN THE CALENDAR');
const flightsSvc = require('../src/services/flights');
const replies = require('../src/services/proactiveReplies');
const fl = (title, location = null) => flightsSvc.detectFlight({ title, location });
check('Gmail flight event', fl('Flight to Dubai (EK 2)', 'London LHR'), { flight: 'EK2', destination: 'Dubai', from: 'LHR' });
check('typed flight number + route', fl('BA117 LHR-JFK'), { flight: 'BA117', destination: 'New York', from: 'LHR' });
check('arrow route, space in number', fl('EK 2 LHR → DXB'), { flight: 'EK2', destination: 'Dubai', from: 'LHR' });
check('"Flight LHR to NCE" without a number', fl('Flight LHR to NCE'), { flight: null, destination: 'Nice', from: 'LHR' });
check('"Flight to New York" (end of title)', fl('Flight to New York').destination, 'New York');
check('unknown airport code shown as the code', fl('VS3 LHR-XYZ').destination, 'XYZ');
check('number only, no place', fl('Board review then BA432'), { flight: 'BA432', destination: null, from: null });
check('not a flight: "Q3 2026 planning"', fl('Q3 2026 planning'), null);
check('not a flight: "M25 traffic"', fl('Drive via M25 2pm'), null);
check('not a flight: "Book flight for mum"', fl('Book flight for mum'), null);
check('not a flight: dinner', fl('Dinner at Zuma'), null);
check('{{10}} as approved: "5th of April"', flightsSvc.ordinalDate('2026-04-05T09:00:00Z', 'Europe/London'), '5th of April');
check('{{10}} 1st / 22nd / 13th', ['2026-11-01', '2026-11-22', '2026-11-13'].map((d) => flightsSvc.ordinalDate(`${d}T12:00:00Z`)), ['1st of November', '22nd of November', '13th of November']);
check('{{10}} in the client timezone', flightsSvc.ordinalDate('2026-11-06T22:30:00Z', 'Asia/Dubai'), '7th of November');
check('{{10}} bad timezone falls back to London', flightsSvc.ordinalDate('2026-11-06T12:00:00Z', 'Nope/Nope'), '6th of November');
check('transit template numbers as approved {{1}} {{18}} {{10}}', templates.TEMPLATES.transit_ping.variables(u, { destination: 'Dubai', date: '6th of November' }), { 1: 'Tim', 18: 'Dubai', 10: '6th of November' });
check('transit SID default (approved one)', config.templates.transit_ping, 'HX4585f83226549166e9c89c4e73a9630d');
check('transit plain-text twin', templates.TEMPLATES.transit_ping.text(u, { destination: 'Dubai', date: '6th of November' }),
  'Hello Tim. I see you are traveling to Dubai on 6th of November. Would you like me to arrange an uber, or secure rail tickets?');
const meta = { flight: 'EK2', destination: 'Dubai', from_airport: 'LHR', departs: '2026-11-06T08:40:00Z' };
check('flight line for Alice', replies.flightLine(meta, 'Europe/London'), 'flight EK2 to Dubai from LHR departing Friday 6 November at 08:40');
check('flight line, all-day event', replies.flightLine({ ...meta, departs: '2026-11-06' }), 'flight EK2 to Dubai from LHR departing Friday 6 November');
check('[Uber] note: pickup time + request_transit + Schedule', [/request_transit/, /Schedule/, /3 hours before/].every((re) => re.test(replies.transitUberNote(meta, 'Europe/London'))), true);
const uberNote = replies.transitUberNote(meta, 'Europe/London');
check('[Uber] note: pickup time worked out (08:40 - 3 h)', /Friday 6 November at 05:40/.test(uberNote), true);
check('[Uber] note: drop-off is the departure airport, no guessed terminal', [/"London Heathrow Airport"/.test(uberNote), /terminal only if the client gave one/.test(uberNote)], [true, true]);
check('[Uber] note: new trip, nothing reused', /do not reuse any address/.test(uberNote), true);
check('[Uber] note: London airport -> London time even for a Dubai-based client', /05:40/.test(replies.transitUberNote(meta, 'Asia/Dubai')), true);
check('[Uber] note: unknown airport -> client timezone', /09:40/.test(replies.transitUberNote({ ...meta, from_airport: 'XYZ' }, 'Asia/Dubai')), true);
check('airport timezone', [flightsSvc.airportTimezone('LHR'), flightsSvc.airportTimezone('DXB'), flightsSvc.airportTimezone('XYZ')], ['Europe/London', 'Asia/Dubai', null]);

console.log('\nFLOW 6: TRIPS IN THE CALENDAR');
const tripsSvc = require('../src/services/trips');
const promptContext = require('../src/services/promptContext');
const geocodeMod = require('../src/integrations/geocode');
const allDay = (title, start, end, location = null) => ({ title, start, end, all_day: true, location });
check('travel ping off, 11:00, 14 days ahead', [config.lifecycle.travelPing, config.lifecycle.travelPingHour, config.lifecycle.travelDaysAhead], [false, 11, 14]);
check('multi-day: all-day 3 days', tripsSvc.isMultiDay(allDay('Rome', '2026-11-10', '2026-11-13')), true);
check('not multi-day: one all-day day', tripsSvc.isMultiDay(allDay("Mum's birthday", '2026-11-10', '2026-11-11')), false);
check('multi-day: timed 2 nights', tripsSvc.isMultiDay({ start: '2026-11-10T09:00:00Z', end: '2026-11-12T18:00:00Z' }), true);
check('not multi-day: a 3-hour meeting', tripsSvc.isMultiDay({ start: '2026-11-10T09:00:00Z', end: '2026-11-10T12:00:00Z' }), false);
check('airport code in title -> city', tripsSvc.airportDestination({ title: 'Trip FCO', location: null }), 'Rome');
check('airport code in location -> city', tripsSvc.airportDestination({ title: 'Offsite', location: 'Nice NCE' }), 'Nice');
check('place name from a location', tripsSvc.placeName('Soho Farmhouse, Chipping Norton OX7'), 'Soho Farmhouse');
check('home city from the profile', [
  promptContext.homeCity({ preferences: { lifestyle_preferences: { home_city: 'London' } } }),
  promptContext.homeCity({ preferences: '{"work_city":"Paris"}' }),
  promptContext.homeCity({}),
], ['London', 'Paris', null]);
check('trip dates in the client timezone', flows.localDate('2026-11-06T22:30:00Z', 'Asia/Dubai'), '2026-11-07');
const tripMeta = { destination: 'Rome', start_date: '2026-11-10', end_date: '2026-11-12' };
check('[Ready] ack (brief wording)', replies.travelAck('Rome'), 'Wonderful. Give me just a moment to cross-reference top-tier local availability for Rome...');
check('[Ready] note: both tools, dates, short links', [/search_curated_experiences/, /check_dining_availability/, /2026-11-10 to 2026-11-12/, /short link/].every((re) => re.test(replies.travelNote(tripMeta))), true);
check('travel template numbers as approved {{1}} {{18}}', templates.TEMPLATES.travel_ping.variables(u, { destination: 'Rome' }), { 1: 'Tim', 18: 'Rome' });
check('travel SID default (approved one)', config.templates.travel_ping, 'HX002ae25165dcb9984ee5c148f5d356a4');
(async () => {
  const romeTrip = allDay('Rome weekend FCO', '2026-11-10', '2026-11-13');
  check('trip by airport code', await tripsSvc.detectTrip(romeTrip, 'London'), { destination: 'Rome', rule: 'airport' });
  check('no trip: airport is the home city', await tripsSvc.detectTrip(allDay('Back home LHR', '2026-11-10', '2026-11-13'), 'London'), null);
  check('no trip: one day only', await tripsSvc.detectTrip(allDay('FCO day', '2026-11-10', '2026-11-11'), 'London'), null);
  check('no trip: no home city and no airport code', await tripsSvc.detectTrip(allDay('Offsite', '2026-11-10', '2026-11-13', 'Soho Farmhouse'), null), null);
  // Distance rule with the map stubbed (no network in unit tests).
  const realFind = geocodeMod.findPlace;
  const places = { London: { lat: 51.5074, lon: -0.1278 }, 'Soho Farmhouse, Chipping Norton': { lat: 51.95, lon: -1.54 }, 'Richmond, London': { lat: 51.461, lon: -0.303 } };
  geocodeMod.findPlace = async (q) => places[q] || null;
  try {
    check('trip by distance (> 50 miles)', await tripsSvc.detectTrip(allDay('Weekend away', '2026-11-10', '2026-11-13', 'Soho Farmhouse, Chipping Norton'), 'London'),
      { destination: 'Soho Farmhouse', rule: 'distance', miles: 68 });
    check('no trip: under 50 miles', await tripsSvc.detectTrip(allDay('Staycation', '2026-11-10', '2026-11-13', 'Richmond, London'), 'London'), null);
    check('no trip: place not on the map', await tripsSvc.detectTrip(allDay('Somewhere', '2026-11-10', '2026-11-13', 'Nowhere Lane'), 'London'), null);
  } finally {
    geocodeMod.findPlace = realFind;
  }
})();
check('pickup: 2 h for a UK domestic flight', flightsSvc.suggestedPickup('2026-11-06T08:40:00Z', { from: 'LHR', destination: 'Edinburgh' }).hoursBefore, 2);
check('pickup: unknown when the event is all-day', flightsSvc.suggestedPickup('2026-11-06', { from: 'LHR' }), null);
check('airport name: LHR / unknown code', [flightsSvc.airportName('LHR'), flightsSvc.airportName('XYZ'), flightsSvc.airportName(null)], ['London Heathrow Airport', 'XYZ airport', null]);
check('[Rail] note: hand to the desk', /handoff_to_concierge/.test(replies.transitRailNote(meta, 'Europe/London')), true);

console.log('\nAGENT TOOLS');
const stranger = '00000000-0000-4000-8000-000000000000';
const tester = config.testTools.userIds[0];
check('client: no tools while off', agentTools.definitionsFor(stranger).length, 0);
check('client: no prompt block while off', agentTools.promptBlock(stranger), '');
check('test account: all tools', agentTools.definitionsFor(tester).map((t) => t.name), [
  'queue_local_dispatch', 'submit_private_inquiry', 'check_dining_availability',
  'source_retail_gift', 'search_curated_experiences', 'search_local_events', 'request_transit', 'search_rail_routes',
]);
check('routing block: rail via search_rail_routes', /search_rail_routes/.test(agentTools.promptBlock(tester)), true);
check('test account: routing block', /submit_private_inquiry/.test(agentTools.promptBlock(tester)), true);
check('routing block: dining checked first', /check_dining_availability first/.test(agentTools.promptBlock(tester)), true);
check('routing block: copy link/phone/price on hand-off', /booking_link, vendor_phone and price/.test(agentTools.promptBlock(tester)), true);
config.agentTools.enabled = true;
check('switched on: everyone gets them', agentTools.definitionsFor(stranger).length, 8);
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
const otDated = agentTools.mapOpenTable(bacchanalia, '19:30', { date: '2026-11-07', party: 2 });
check('OpenTable link opens at the closest free time (18:45), not the asked 19:30',
  [otDated.link_opens_at, otDated.booking_link], ['18:45', 'https://www.opentable.com/restaurant/profile/285378?covers=2&dateTime=2026-11-07T18%3A45']);
check('OpenTable link: nothing free -> the asked time', agentTools.mapOpenTable({ ...bacchanalia, availabilitySlots: { slots: [] } }, '19:30', { date: '2026-11-07' }).booking_link,
  'https://www.opentable.com/restaurant/profile/285378?covers=2&dateTime=2026-11-07T19%3A30');

console.log('\nRAIL');
check('National Rail link as checked in a browser (KGX -> EDB, Sat 7 Nov 09:00)',
  agentTools.nationalRailLink({ from: 'KGX', to: 'EDB', date: '2026-11-07', time: '09:00' }),
  'https://www.nationalrail.co.uk/journey-planner/?type=single&origin=KGX&destination=EDB&leavingType=departing&leavingDate=071126&leavingHour=09&leavingMin=00&adults=1&extendedSearch=false');
check('National Rail link: arrive by, 2 adults', new URL(agentTools.nationalRailLink({ from: 'PAD', to: 'HWV', date: '2026-11-07', time: '6:00', arriveBy: true, adults: 2 })).searchParams.toString(),
  'type=single&origin=PAD&destination=HWV&leavingType=arriving&leavingDate=071126&leavingHour=06&leavingMin=00&adults=2&extendedSearch=false');
(async () => {
  const geo = require('../src/integrations/geocode');
  check('station: a code passes through, named from the list', await geo.findStation('KGX'), { code: 'KGX', name: 'London Kings Cross' });
  const codes = [];
  for (const s of ['Heathrow Terminal 5 station', 'Heathrow T5', 'Brighton', "King's Cross", 'Edinburgh', 'Manchester', 'Manchester Airport', 'Bath', 'Nowhere Junction XYZ']) {
    codes.push((await geo.findStation(s))?.code || null);
  }
  check('station names -> codes (Brighton was the OSM miss; a bare city = its main station)', codes,
    ['HWV', 'HWV', 'BTN', 'KGX', 'EDB', 'MAN', 'MIA', 'BTH', null]);
})();
const railNote = replies.transitRailNote({ flight: 'BA117', destination: 'New York', from_airport: 'LHR', departs: '2026-11-07T10:15:00Z' }, 'Asia/Dubai');
check('[Rail] note: arrive 2.5 h before, London time, rail tool, team option', [/07:45/, /search_rail_routes/, /arrive_by true/, /HWV/, /handoff_to_concierge/].every((re) => re.test(railNote)), true);
check('[Rail] note: airport without a station -> offer Uber', /request_transit/.test(replies.transitRailNote({ flight: 'BA1', destination: 'Paris', from_airport: 'EDI', departs: '2026-11-07T10:15:00Z' }, 'Europe/London')), true);
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
check('product shape: shop link, delivery', agentTools.mapProduct({
  productName: 'Pink Peonies & Roses', merchantName: 'Blossoming Gifts', price: '£44.99',
  merchantLink: 'https://www.google.co.uk/goto?url=CAES', productLink: 'https://www.google.co.uk/search?q=x',
  deliveryInfo: 'Delivery between Saturday – Monday £4.99', deliveryFee: '£4.99',
}), {
  title: 'Pink Peonies & Roses', store: 'Blossoming Gifts', price: '£44.99',
  delivery: 'Delivery between Saturday – Monday £4.99', booking_link: 'https://www.google.co.uk/goto?url=CAES',
});
check('product: fee added when the delivery text lacks it', agentTools.mapProduct({ productName: 'x', price: '£1', deliveryInfo: 'Next day', deliveryFee: '£6.95' }).delivery, 'Next day, fee £6.95');
check('shop link: tracking removed', agentTools.cleanShopUrl('https://www.blossominggifts.com/pomegranate-rose-peony-bg?srsltid=AYCX9&utm_source=g&size=l'), 'https://www.blossominggifts.com/pomegranate-rose-peony-bg?size=l');
check('OpenTable link opens on the date, time and guests', agentTools.openTableLink('https://www.opentable.com/restaurant/profile/286230', { date: '2026-11-06', time: '19:30', party: 2 }),
  'https://www.opentable.com/restaurant/profile/286230?covers=2&dateTime=2026-11-06T19%3A30');
check('OpenTable link: no date -> plain page', agentTools.openTableLink('https://www.opentable.com/restaurant/profile/1', {}), 'https://www.opentable.com/restaurant/profile/1');
check('routing block: short link under every option', /short "link" on its own line/.test(agentTools.promptBlock(tester)), true);
check('routing block: no markdown links', /never \[text\]\(url\)/.test(agentTools.promptBlock(tester)), true);
check('routing block: bold style left to Alice (Tim likes **double**)', /single asterisks/.test(agentTools.promptBlock(tester)), false);
check('routing block: near-matches named, not hidden', /say plainly how it differs/.test(agentTools.promptBlock(tester)), true);

console.log('\nTRANSIT');
const geocode = require('../src/integrations/geocode');
const t5 = geocode.parseResult({ lat: '51.4723', lon: '-0.4886', name: 'Terminal 5', display_name: 'Terminal 5, Heathrow, London, TW6 2GA' });
check('Nominatim result parsed', t5, { lat: 51.4723, lon: -0.4886, name: 'Terminal 5', address: 'Terminal 5, Heathrow, London, TW6 2GA' });
check('Nominatim: nothing found -> null', geocode.parseResult(undefined), null);
check('Charing Cross to Heathrow T5 is about 16 miles', Math.round(geocode.milesBetween({ lat: 51.5074, lon: -0.1278 }, t5)), 16);
check('address attempts: full, no "The", postcode, street', geocode.attemptsFor('The Savoy, Strand, London WC2R 0EZ'), [
  { q: 'The Savoy, Strand, London WC2R 0EZ', match: 'exact' },
  { q: 'Savoy, Strand, London WC2R 0EZ', match: 'exact' },
  { q: 'WC2R 0EZ', match: 'postcode' },
  { q: 'Strand, London WC2R 0EZ', match: 'street' },
]);
check('address attempts: plain place -> just itself', geocode.attemptsFor('Heathrow Terminal 5'), [{ q: 'Heathrow Terminal 5', match: 'exact' }]);
const loc = agentTools.uberLocation(t5, 'Heathrow T5');
check('Uber location fields (Uber docs names)', Object.keys(loc), ['latitude', 'longitude', 'addressLine1', 'addressLine2']);
const link = new URL(agentTools.uberLink({ drop: loc, clientId: null }));
check('Uber link base', `${link.origin}${link.pathname}`, 'https://m.uber.com/looking');

console.log('\nSHORT LINKS');
const shortLinks = require('../src/services/shortLinks');
const codes = new Set(Array.from({ length: 200 }, () => shortLinks.newCode()));
check('codes: 8 URL-safe characters', [...codes].every((c) => shortLinks.CODE.test(c)), true);
check('codes: no repeats in 200', codes.size, 200);
check('site names for the link', [
  'https://m.uber.com/looking?pickup=x', 'https://www.opentable.com/restaurant/profile/1', 'https://www.moysesflowers.co.uk/peony-delight',
  'https://www.getyourguide.com/edinburgh-l44/x', 'https://www.eventbrite.co.uk/e/1', 'https://www.bloomandwild.com/send-flowers/x', 'not a url',
].map(shortLinks.siteLabel), ['uber', 'opentable', 'moysesflowers', 'getyourguide', 'eventbrite', 'bloomandwild', null]);
check('only web links are shortened', [shortLinks.isWebUrl('https://a.co/x'), shortLinks.isWebUrl('javascript:alert(1)'), shortLinks.isWebUrl('')], [true, false, false]);
(async () => {
  const fake = async (url) => `https://x.app/go/${url.length}`;
  const r = await agentTools.addShortLinks({ ok: true, options: [{ booking_link: 'https://shop/a' }, { name: 'no link' }] }, 'u', null, fake);
  check('every option with a booking_link gets a short link; full link kept', [r.options[0].link, r.options[0].booking_link, 'link' in r.options[1]], ['https://x.app/go/14', 'https://shop/a', false]);
  const tr = await agentTools.addShortLinks({ ok: true, booking_link: 'https://m.uber.com/looking?x' }, 'u', null, fake);
  check('transit result gets a short link too', tr.link, 'https://x.app/go/28');
  const none = await shortLinks.shorten('https://m.uber.com/looking?x', {}, null);
  check('no PUBLIC_BASE_URL -> full link (never a dead one)', none, config.publicBaseUrl ? none : 'https://m.uber.com/looking?x');
})();
check('Uber link: drop[0] is the JSON location', JSON.parse(link.searchParams.get('drop[0]')).latitude, 51.4723);
check('Uber link: no pickup -> current location (param left out)', link.searchParams.has('pickup'), false);
check('Uber link: client_id only when set', new URL(agentTools.uberLink({ drop: loc, clientId: 'abc' })).searchParams.get('client_id'), 'abc');
check('routing block: transit Path A + B', [/request_transit/.test(agentTools.promptBlock(tester)), /queue_local_dispatch/.test(agentTools.promptBlock(tester))], [true, true]);
check('parseGbp', [agentTools.parseGbp('£1,170.50'), agentTools.parseGbp('n/a')], [1170.5, null]);
check('flower search gets "fresh flower delivery"', agentTools.giftQuery('peony bouquet'), 'peony bouquet fresh flower delivery');
check('non-flower and artificial searches left alone', [agentTools.giftQuery('Smythson notebook'), agentTools.giftQuery('silk peony bouquet')], ['Smythson notebook', 'silk peony bouquet']);
// The 1 Nov result that went wrong: one real bouquet + the same silk bouquet from five shops.
const nov1 = [
  { title: 'Fresh Peonies Bouquet Pink Peonies', store: 'Flowers by Flourish', price: '£30.00' },
  { title: 'Essential Pink Peony Bouquet', store: 'Country Baskets', price: '£2.99' },
  { title: 'Essential Pink Peony Bouquet', store: 'Whittingtons Silk Flowers', price: '£4.15' },
  { title: 'Essential Pink Peony Bouquet', store: 'The Range', price: '£7.99' },
  { title: 'Moyses Stevens Peonies and Roses', store: 'Moyses Stevens Flowers', price: '£75.00' },
  { title: 'Fresh Peony Bouquet', store: 'Flowers by Flourish', price: '£41.60' },
  { title: 'Peony Next Day Delivery', store: 'Flowers by Flourish', price: '£85.00' },
];
check('flowers: no silk / toy-priced bouquets, other shops first', agentTools.pickGifts(nov1, 'peony bouquet').map((p) => `${p.store} ${p.price}`),
  ['Flowers by Flourish £30.00', 'Moyses Stevens Flowers £75.00', 'Flowers by Flourish £41.60', 'Flowers by Flourish £85.00']);
const nov1Events = [
  { name: 'Intensive Environmental Arts Therapy Weekend', date: '2026-11-01', time: '10:00' },
  { name: 'Isoartee Free Art Workshops', date: '2026-11-05', time: '11:00' },
  { name: 'Late View: Hockney Prints', date: '2026-11-04', time: '18:30' },
  { name: 'Saturday Art Class with London Art Classes', date: '2026-11-07', time: '11:00' },
];
check('events: started ones out, classes/workshops after the rest',
  agentTools.rankEvents(nov1Events, { now: new Date('2026-11-01T13:14:00Z'), tz: 'Europe/London' }).map((e) => e.name),
  ['Late View: Hockney Prints', 'Isoartee Free Art Workshops', 'Saturday Art Class with London Art Classes']);
check('asked for silk -> silk allowed', agentTools.pickGifts(nov1, 'silk peony bouquet').length, 5);
check('not flowers -> no price floor', agentTools.pickGifts([{ title: 'Card', store: 'Papier', price: '£4.50' }], 'birthday card').length, 1);check('tour price in pounds', agentTools.mapTour({ title: 'Sky Garden', price: 13.5, currency: 'GBP', url: 'https://gyg/x', provider: 'GetYourGuide' }).price, '£13.5');
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
