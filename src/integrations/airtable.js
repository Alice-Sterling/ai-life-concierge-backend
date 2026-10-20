/**
 * Airtable client.
 *
 * Airtable is the human-facing ops dashboard. Postgres stays the source of truth;
 * this module pushes operational state outward so the ops team can see it.
 *
 * Deliberately NOT synced: `events` and `automation_logs`. They are high-volume
 * append-only tables and would exhaust the Airtable API quota for no operator
 * benefit. See the brief, section 2F.
 *
 * Every write is best-effort. Airtable being slow or down must never fail a
 * WhatsApp reply, so callers get `false` and a log line, not an exception.
 */

const { config } = require('../config');
const { logger } = require('../lib/logger');

const API_ROOT = 'https://api.airtable.com/v0';
const TIMEOUT_MS = 10_000;

function isConfigured() {
  return Boolean(config.airtable.apiKey && config.airtable.baseId && config.airtable.userTableRef);
}

function tableUrl(tableRef) {
  return `${API_ROOT}/${encodeURIComponent(config.airtable.baseId)}/${encodeURIComponent(tableRef)}`;
}

/**
 * Escape a value before embedding it in a filterByFormula string literal.
 * Without this, an apostrophe in a name terminates the literal and the formula
 * either errors or matches the wrong rows.
 */
function escapeFormulaString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function request(method, url, { body, log = logger } = {}) {
  if (!isConfigured()) return { ok: false, skipped: true };

  // Airtable occasionally hangs rather than refusing. An unbounded fetch inside
  // a webhook handler holds the request open until Twilio gives up on us.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.airtable.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn('airtable.request_failed', {
        integration: 'airtable',
        method,
        status: res.status,
        detail: detail.slice(0, 300),
      });
      return { ok: false, status: res.status };
    }

    return { ok: true, data: await res.json() };
  } catch (err) {
    log.warn('airtable.request_error', {
      integration: 'airtable',
      method,
      message: err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message,
    });
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Find one record by a field value. Returns { id, fields }, or null. */
async function findRecord(tableRef, field, value, log = logger) {
  const formula = encodeURIComponent(`{${field}} = '${escapeFormulaString(value)}'`);
  const url = `${tableUrl(tableRef)}?filterByFormula=${formula}&maxRecords=1`;
  const res = await request('GET', url, { log });
  return res.ok ? res.data.records?.[0] ?? null : null;
}

/** Find one record by a field value. Returns the record id, or null. */
async function findRecordId(tableRef, field, value, log = logger) {
  return (await findRecord(tableRef, field, value, log))?.id ?? null;
}

/**
 * The digit strings one phone number can appear as. People type numbers on
 * the website as "07700 900123", "+44 7700-900123" or "447700900123", and
 * WhatsApp sends "whatsapp:+447700900123": all of them are the same client.
 *
 * @returns {string[]} digits only, international form first
 */
function phoneDigitVariants(phone) {
  let d = String(phone || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (!d) return [];
  if (d.startsWith('00')) d = d.slice(2);
  // UK national format (07…, 11 digits) is +44 7…
  if (d.length === 11 && d.startsWith('0')) d = `44${d.slice(1)}`;
  const out = [d];
  if (d.startsWith('44') && d.length === 12) out.push(`0${d.slice(2)}`);
  return out;
}

/**
 * Airtable formula matching the phone field on digits only, so spaces, dashes,
 * brackets and a leading + or 0 in the cell do not stop the match.
 */
function phoneMatchFormula(field, phone) {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return null;
  const cell = `REGEX_REPLACE({${field}} & '', '[^0-9]', '')`;
  return `OR(${variants.map((v) => `${cell} = '${escapeFormulaString(v)}'`).join(', ')})`;
}

async function findRecordByPhone(tableRef, field, phone, log = logger) {
  const formula = phoneMatchFormula(field, phone);
  if (!formula) return null;
  const url = `${tableUrl(tableRef)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await request('GET', url, { log });
  return res.ok ? res.data.records?.[0] ?? null : null;
}

/**
 * Find a client's profile row: by Client ID first, then by phone (any format).
 *
 * @returns {Promise<{id: string, fields: object}|null>}
 */
async function findUserRecord({ clientId = null, phone = null } = {}, log = logger) {
  if (!isConfigured()) return null;
  const tableRef = config.airtable.userTableRef;

  for (const id of new Set([].concat(clientId || []).filter(Boolean))) {
    const byId = await findRecord(tableRef, 'Client ID', id, log);
    if (byId) return byId;
  }
  return phone ? findRecordByPhone(tableRef, config.airtable.phoneField, phone, log) : null;
}

/** Postgres status -> the exact Airtable option ("On boarded" has a space there). */
const AIRTABLE_STATUS = { Onboarded: 'On boarded' };

/** Drop null and empty values so a partial update cannot blank a populated cell. */
function sanitizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Push a user's operational state to Airtable.
 *
 * Called whenever conversation_mode, onboarding_phase or next_date_due_at change
 * in Postgres, per the brief.
 *
 * @returns {Promise<string|null>} the Airtable record id, or null if not synced
 */
async function syncUser(user, log = logger) {
  if (!isConfigured()) return null;

  const fields = sanitizeFields({
    'Client ID': user.client_id || user.short_id,
    [config.airtable.phoneField]: user.phone_number,
    Email: user.email,
    'First Name': user.first_name,
    'Last Name': user.last_name,
    Status: AIRTABLE_STATUS[user.onboarding_phase] || user.onboarding_phase,
    'Conversation Mode': user.conversation_mode,
    'Next Date Due': user.next_date_due_at ? new Date(user.next_date_due_at).toISOString() : null,
    'Onboarding Completed At': user.onboarding_completed_at
      ? new Date(user.onboarding_completed_at).toISOString()
      : null,
  });

  if (Object.keys(fields).length === 0) return null;

  const tableRef = config.airtable.userTableRef;
  // Both ids, then the phone in any format: a miss here used to create a
  // duplicate row for a client who signed up on the website.
  const existing = await findUserRecord({
    clientId: [user.short_id, user.client_id], phone: user.phone_number,
  }, log);
  const recordId = existing?.id || null;
  // Never overwrite the Client ID the website gave an existing row.
  if (existing?.fields?.['Client ID']) delete fields['Client ID'];

  const res = recordId
    ? await request('PATCH', `${tableUrl(tableRef)}/${recordId}`, { body: { fields }, log })
    : await request('POST', tableUrl(tableRef), { body: { fields, typecast: true }, log });

  if (!res.ok) return null;

  const id = recordId || res.data?.id || null;
  log.info('airtable.user_synced', { integration: 'airtable', user_id: user.id, record_id: id });
  return id;
}

/**
 * Push a task to the Airtable Tasks table.
 *
 * The Postgres UUID is written to a text field so the two systems can be
 * reconciled, and the user's profile record is attached through a linked field
 * (Airtable expects an array of record ids there, even for a single link).
 *
 * @returns {Promise<string|null>} the Airtable record id, or null if not synced
 */
async function syncTask(task, userRecordId, log = logger) {
  const tableRef = config.airtable.tasksTableRef;
  if (!isConfigured() || !tableRef) return null;

  const fields = sanitizeFields({
    'Task ID': task.task_id,
    Summary: task.ai_summary,
    'Source Message': task.source_message,
    Status: task.status,
    Priority: task.priority,
    Category: task.category,
    'Assigned To': task.assigned_to,
    'Requires Human': Boolean(task.requires_human),
    ...(userRecordId ? { [config.airtable.tasksUserLinkField]: [userRecordId] } : {}),
  });

  const existing = task.airtable_record_id
    || (await findRecordId(tableRef, 'Task ID', task.task_id, log));

  const res = existing
    ? await request('PATCH', `${tableUrl(tableRef)}/${existing}`, { body: { fields }, log })
    : await request('POST', tableUrl(tableRef), { body: { fields, typecast: true }, log });

  if (!res.ok) return null;

  const id = existing || res.data?.id || null;
  log.info('airtable.task_synced', { integration: 'airtable', task_id: task.task_id, record_id: id });
  return id;
}

/** Connectivity probe for /health/integrations. Reads one record; writes nothing. */
async function healthCheck() {
  if (!isConfigured()) {
    return { status: 'not_configured', configured: false };
  }
  const startedAt = Date.now();
  const res = await request('GET', `${tableUrl(config.airtable.userTableRef)}?maxRecords=1`);
  return {
    status: res.ok ? 'ok' : 'error',
    configured: true,
    latency_ms: Date.now() - startedAt,
    ...(res.ok ? {} : { error: res.error || `HTTP ${res.status}` }),
  };
}

module.exports = {
  isConfigured, syncUser, syncTask, findRecord, findRecordId, findUserRecord,
  phoneDigitVariants, phoneMatchFormula, healthCheck,
};
