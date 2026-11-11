/**
 * Airtable -> backend: what the desk (or the website form) changes in the
 * Clients table takes effect in the backend (Tim, 11 Nov: "when we change in
 * Airtable we need those changes to effect everything").
 *
 * Before this only Status travelled (n8n's 5-minute check + the front door on
 * every message). Home City, Partner Name, Dietary, Cuisine, automations,
 * Conversation Mode and the date-night fields stayed in Airtable, so Alice never
 * saw the website form's answers and a desk edit changed nothing.
 *
 * When it runs:
 *   - on every inbound message, with the record the front door already read
 *   - every 15 minutes for every client (the lifecycle job), so proactive jobs
 *     and a mode the desk flipped take effect without the client writing
 *
 * Status is NOT handled here: n8n + the front door own it (with its templates).
 *
 * The rule that keeps the two systems from undoing each other: a field is
 * applied only when its Airtable value differs from the value this sync last
 * saw there (kept in preferences.airtable_seen). A change made by a person in
 * Airtable is applied; a backend change whose push to Airtable failed is not
 * reverted by the old Airtable value.
 */

const db = require('../db/pool');
const airtable = require('../integrations/airtable');
const users = require('./users');
const { config } = require('../config');
const { logger } = require('../lib/logger');

/** Airtable text field -> lifestyle_preferences key (what Alice's profile block reads). */
const PROFILE_FIELDS = {
  'Home City': 'home_city',
  'Work City': 'work_city',
  'Partner Name': 'partner_name',
  'Dietary Restrictions': 'dietary_restrictions',
  'Favorite Cuisine': 'favorite_cuisine',
};

/** Website automation labels (as the form writes them into Airtable) -> backend slugs. */
const AUTOMATION_LABELS = [
  [/date night/i, 'date_night'],
  [/milestone|flowers|card delivery|gift/i, 'gifting'],
  [/door-to-door|destination|travel/i, 'travel_logistics'],
];
const CADENCE_WORDS = [[/weekly/i, 7], [/fortnightly|bi-?weekly/i, 14], [/monthly/i, 30]];

const text = (v) => (v == null ? null : String(Array.isArray(v) ? v.join(', ') : v).trim() || null);

/** "Regular Date Night Automation (monthly), Proactive Milestone Proposals" -> ['date_night', 'gifting']. */
function automationSlugs(value) {
  const out = new Set();
  for (const part of String(value || '').split(',')) {
    for (const [re, slug] of AUTOMATION_LABELS) if (re.test(part)) out.add(slug);
  }
  return [...out];
}

/** The date-night rhythm in the label, in days, or null: "(monthly)" -> 30. */
function cadenceFromLabels(value) {
  const part = String(value || '').split(',').find((p) => /date night/i.test(p)) || '';
  for (const [re, days] of CADENCE_WORDS) if (re.test(part)) return days;
  return null;
}

/** The values this sync reads from one Clients record, normalised (null = empty cell). */
function readFields(f = {}) {
  const mode = text(f['Conversation Mode'])?.toLowerCase();
  const cadence = Number(f['Date Night Cadence']);
  return {
    first_name: text(f['First Name']),
    last_name: text(f.Last_Name),
    email: text(f.email),
    conversation_mode: mode === 'human' || mode === 'ai' ? mode : null,
    automations: text(f.ActiveAutomations),
    date_night_cadence: Number.isFinite(cadence) && cadence > 0 ? cadence : null,
    next_date_due: text(f['Next Date Due'])?.slice(0, 10) || null,
    ...Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([field, key]) => [key, text(f[field])])),
  };
}

const parseJson = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}') || {}; } catch { return {}; }
};

/**
 * What to change in the backend: fields whose Airtable value is set and has
 * changed since this sync last saw it. Pure, for tests.
 * @returns {{ changes: object, seen: object }}
 */
function diff(fields, seenBefore = {}) {
  const changes = {};
  const seen = { ...seenBefore };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (seenBefore[key] !== value) changes[key] = value;
    seen[key] = value;
  }
  return { changes, seen };
}

/**
 * Apply one Clients record to one backend user.
 * @returns {Promise<string[]>} the names of the fields that changed
 */
async function applyRecord(user, record, log = logger) {
  if (!user?.id || !record?.fields) return [];
  const { rows } = await db.query('SELECT preferences FROM users WHERE id = $1', [user.id], log);
  const prefs = parseJson(rows[0]?.preferences);
  const { changes, seen } = diff(readFields(record.fields), prefs.airtable_seen || {});
  const changed = Object.keys(changes);
  if (!changed.length) {
    if (JSON.stringify(prefs.airtable_seen || {}) !== JSON.stringify(seen)) {
      await db.query(`UPDATE users SET preferences = jsonb_set(preferences, '{airtable_seen}', $2::jsonb) WHERE id = $1::uuid`,
        [user.id, JSON.stringify(seen)], log);
    }
    return [];
  }

  const lifestyle = { ...(prefs.lifestyle_preferences || {}) };
  for (const key of Object.values(PROFILE_FIELDS)) if (key in changes) lifestyle[key] = changes[key];

  const sets = [];
  const params = [user.id];
  // Every parameter carries its type (HANDOFF rule 7: untyped $n has bitten three times).
  const set = (col, value, cast) => { params.push(value); sets.push(`${col} = $${params.length}::${cast}`); };
  if ('first_name' in changes) set('first_name', changes.first_name, 'text');
  if ('last_name' in changes) set('last_name', changes.last_name, 'text');
  if ('email' in changes) set('email', changes.email, 'text');
  if ('automations' in changes) {
    set('active_automations', JSON.stringify(automationSlugs(changes.automations)), 'jsonb');
    const fromLabel = cadenceFromLabels(changes.automations);
    if (fromLabel && !('date_night_cadence' in changes)) set('date_night_cadence', fromLabel, 'int');
  }
  if ('date_night_cadence' in changes) set('date_night_cadence', changes.date_night_cadence, 'int');
  if ('next_date_due' in changes) set('next_date_due_at', `${changes.next_date_due}T00:00:00Z`, 'timestamptz');
  set('preferences', JSON.stringify({ ...prefs, lifestyle_preferences: lifestyle, airtable_seen: seen }), 'jsonb');

  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1::uuid`, params, log);

  // Mode goes through the normal setter: it starts the 2-hour auto-resume clock.
  if ('conversation_mode' in changes && changes.conversation_mode !== user.conversation_mode) {
    await users.setConversationMode(user.id, changes.conversation_mode, { source: 'airtable' }, log);
  }

  log.info('airtable_sync.applied', { user_id: user.id, fields: changed });
  return changed;
}

const digits = (p) => String(p || '').replace(/\D/g, '').replace(/^44/, '0').replace(/^0+/, '');

/**
 * Every client: match Airtable records to backend users (Client ID first, then
 * the phone number in any format) and apply them.
 */
async function syncAll(log = logger) {
  const records = await airtable.listUserRecords(log);
  if (!records) return { ok: false, reason: 'airtable_unreadable' };

  const { rows: people } = await db.query(
    'SELECT id, client_id, short_id, phone_number, conversation_mode FROM users', [], log);
  const byId = new Map();
  const byPhone = new Map();
  for (const r of records) {
    const cid = text(r.fields?.['Client ID']);
    if (cid) byId.set(cid, r);
    const ph = digits(r.fields?.[config.airtable.phoneField]);
    if (ph && !byPhone.has(ph)) byPhone.set(ph, r);
  }

  const result = { users: people.length, matched: 0, changed: 0 };
  for (const u of people) {
    const record = byId.get(u.short_id) || byId.get(u.client_id) || byPhone.get(digits(u.phone_number));
    if (!record) continue;
    result.matched += 1;
    try {
      if ((await applyRecord(u, record, log.child({ user_id: u.id }))).length) result.changed += 1;
    } catch (err) {
      log.warn('airtable_sync.user_failed', { user_id: u.id, message: err.message });
    }
  }
  log.info('airtable_sync.done', result);
  return result;
}

module.exports = { PROFILE_FIELDS, automationSlugs, cadenceFromLabels, readFields, diff, applyRecord, syncAll };
