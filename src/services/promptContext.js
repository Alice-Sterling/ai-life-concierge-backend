/**
 * Step C context blocks for Alice's system prompt (Project 3).
 *
 *   profileBlock()   the client's lifestyle preferences, flattened: one line
 *                    per field that has a value, nothing for empty ones, so
 *                    Alice is never shown "Partner Name: null"
 *   tasksBlock()     what the concierge team is already handling, so Alice
 *                    does not duplicate it; omitted when there is nothing open
 *   calendarBlock()  the brief's "calendar is CONNECTED, never ask to
 *                    reconnect" rule, only when it is true
 *
 * Each returns '' when it has nothing to say, which keeps the prompt lean.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const OPEN_STATUSES = ['new', 'triaged', 'in_progress'];
const MAX_TASKS = 5;

/** Label -> where the value may live. The website form, Alice's intake and older rows all differ. */
const PROFILE_FIELDS = [
  ['Home City', ['home_city', 'homeCity', 'city']],
  ['Work City', ['work_city', 'workCity']],
  ['Partner Name', ['partner_name', 'partnerName']],
  ['Dietary Restrictions', ['dietary_restrictions', 'dietaryRestrictions', 'dietary']],
  ['Favorite Cuisine', ['favorite_cuisine', 'favourite_cuisine', 'favoriteCuisine', 'cuisines']],
  ['Preferred Area', ['neighborhood', 'neighbourhood']],
  ['Budget', ['budget']],
];

const isEmpty = (v) => v == null
  || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.filter((x) => !isEmpty(x)).length === 0);

const sanitize = (v, max = 180) => {
  const text = String(v ?? '')
    .replace(/\r/g, '\n')
    .replace(/(^|\n)\s*(#{1,6}\s*|\[(?:SYSTEM|TOOL|CONTEXT|AI_SUMMARY|TRIGGER)[^\]]*\]\s*)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
};

const asText = (v) => (
  Array.isArray(v)
    ? v.filter((x) => !isEmpty(x)).map((x) => sanitize(x, 80)).join(', ')
    : sanitize(v)
);

const titleCase = (slug) => String(slug)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** First non-empty value for any of `keys`, searching the likely places in order. */
function pick(prefs, keys) {
  const places = [prefs?.lifestyle_preferences, prefs?.lifestyle, prefs, prefs?.date_night];
  for (const place of places) {
    if (!place || typeof place !== 'object') continue;
    for (const k of keys) if (!isEmpty(place[k])) return place[k];
  }
  return null;
}

function profileBlock(user) {
  const prefs = parseMaybeJson(user?.preferences) || {};
  const lines = [];

  const automations = parseMaybeJson(user?.active_automations)
    || pick(prefs, ['active_automations', 'activeAutomations']);
  if (!isEmpty(automations)) {
    const list = Array.isArray(automations) ? automations : String(automations).split(',');
    lines.push(`Active Automations: ${list.map((a) => titleCase(String(a).trim())).filter(Boolean).join(', ')}`);
  }

  for (const [label, keys] of PROFILE_FIELDS) {
    const v = pick(prefs, keys);
    if (!isEmpty(v)) lines.push(`${label}: ${asText(v)}`);
  }

  if (!lines.length) return '';
  return `\n### USER PROFILE CONTEXT\n${lines.join('\n')}\nUse these as known facts. Never ask for anything listed here.\n`;
}

/**
 * The same profile facts as profileBlock(), as { label: value } for the
 * Command Center's context panel. Empty fields are left out.
 */
function profileFacts(user) {
  const prefs = parseMaybeJson(user?.preferences) || {};
  const out = {};
  const automations = parseMaybeJson(user?.active_automations)
    || pick(prefs, ['active_automations', 'activeAutomations']);
  if (!isEmpty(automations)) {
    const list = Array.isArray(automations) ? automations : String(automations).split(',');
    out['Active Automations'] = list.map((a) => titleCase(String(a).trim())).filter(Boolean).join(', ');
  }
  for (const [label, keys] of PROFILE_FIELDS) {
    const v = pick(prefs, keys);
    if (!isEmpty(v)) out[label] = asText(v);
  }
  return out;
}

async function tasksBlock(userId, log = logger) {
  if (!userId) return '';
  try {
    const { rows } = await db.query(
      `SELECT category, status, ai_summary, created_at
         FROM tasks
        WHERE user_id = $1 AND status::text = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, OPEN_STATUSES, MAX_TASKS], log);
    if (!rows.length) return '';

    const lines = rows.map((t) => {
      const when = new Date(t.created_at).toISOString();
      const summary = sanitize(t.ai_summary || '', 220);
      return `- [${t.status}] ${t.category || 'general'}, ${when}: ${summary || 'no summary'}`;
    });
    return `\n### ACTIVE TASKS (the concierge team is handling these)\n${lines.join('\n')}\n`
      + 'Do not start these again or promise them twice. If the client asks, say the team is on it.\n';
  } catch (err) {
    // Context is a nice-to-have; a failed query must never stop Alice answering.
    log.warn('prompt_context.tasks_failed', { message: err.message });
    return '';
  }
}

function calendarBlock(user, providerLabel) {
  if (user?.calendar_connected !== true) return '';
  const provider = providerLabel || (user.calendar_provider === 'outlook' ? 'Outlook' : 'Google');
  return `\n### CALENDAR STATUS\nThe user's calendar status is CONNECTED (Provider: ${provider}). `
    + 'You have active permission to read availability and schedule events. '
    + 'Never ask them to reconnect their calendar.\n';
}

/** The client's home city from their profile (else work city), or null. Flow 6's 50-mile rule. */
function homeCity(user) {
  const prefs = parseMaybeJson(user?.preferences) || {};
  const v = pick(prefs, ['home_city', 'homeCity', 'city']) || pick(prefs, ['work_city', 'workCity']);
  return isEmpty(v) ? null : asText(v);
}

module.exports = { profileBlock, profileFacts, tasksBlock, calendarBlock, homeCity, OPEN_STATUSES };
