/**
 * Tool orchestration helpers for Alice.
 *
 * The actual tools still live in their service modules. This file provides the
 * agent-facing glue: lightweight JSON-schema checks, human-mode decisions and
 * date/time resolution against the live user timezone context.
 */

const { buildTimeAnchor } = require('./promptBuilder');

function shouldBypassAlice(user) {
  return user?.conversation_mode === 'human';
}

function requiredFieldsFor(toolDefinition) {
  return toolDefinition?.input_schema?.required || [];
}

function propertySchemaFor(toolDefinition, key) {
  return toolDefinition?.input_schema?.properties?.[key] || null;
}

function validateToolInput(toolDefinition, input) {
  if (!toolDefinition) return { ok: true };
  const errors = [];
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const key of requiredFieldsFor(toolDefinition)) {
    if (value[key] == null || value[key] === '') errors.push(`${toolDefinition.name}.${key} is required`);
  }

  for (const [key, v] of Object.entries(value)) {
    const schema = propertySchemaFor(toolDefinition, key);
    if (!schema) continue;
    if (schema.enum && v != null && !schema.enum.includes(v)) {
      errors.push(`${toolDefinition.name}.${key} must be one of: ${schema.enum.join(', ')}`);
    }
    if (schema.type === 'integer' && v != null && !Number.isInteger(Number(v))) {
      errors.push(`${toolDefinition.name}.${key} must be an integer`);
    }
    if (schema.type === 'number' && v != null && Number.isNaN(Number(v))) {
      errors.push(`${toolDefinition.name}.${key} must be a number`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function findToolDefinition(tools, name) {
  return (tools || []).find((tool) => tool?.name === name) || null;
}

function validateToolCall(tools, name, input) {
  return validateToolInput(findToolDefinition(tools, name), input);
}

function timezoneOffsetSuffix(timeZone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
    }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value || timeZone;
  } catch {
    return 'GMT';
  }
}

function resolveRelativeDateTime(phrase, {
  now = new Date(),
  activeTimezone = 'Europe/London',
} = {}) {
  const text = String(phrase || '').trim();
  const base = now instanceof Date ? now : new Date(now);
  if (!text || Number.isNaN(base.getTime())) return null;

  const lower = text.toLowerCase();
  const d = new Date(base.getTime());
  if (/\btomorrow\b/.test(lower)) d.setUTCDate(d.getUTCDate() + 1);
  if (/\btoday\b/.test(lower)) {
    // leave base date unchanged
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wantedDay = weekdays.findIndex((day) => new RegExp(`\\bnext\\s+${day}\\b`).test(lower));
  if (wantedDay >= 0) {
    const current = d.getUTCDay();
    let delta = (wantedDay - current + 7) % 7;
    if (delta === 0) delta = 7;
    d.setUTCDate(d.getUTCDate() + delta);
  }

  const hm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (hm) {
    let hour = Number(hm[1]);
    const minute = Number(hm[2] || 0);
    const ampm = hm[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    d.setUTCHours(hour, minute, 0, 0);
  }

  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} ${activeTimezone} (${timezoneOffsetSuffix(activeTimezone, d)})`;
}

function toolRuntimeBlock({ activeTimezone, now = new Date() } = {}) {
  const anchor = buildTimeAnchor({ activeTimezone, now });
  return `\n### TOOL RUNTIME ANCHOR\nCurrent UTC Time: ${anchor.currentUtcTime}\nUser Timezone: ${anchor.userTimezone}\nResolve relative dates before tool calls. Include the user timezone in free-text time fields.\nTranscript lines start with a "[timestamp] Client:" or "[timestamp] Alice:" label added by the backend. Never write such a label in your reply.\n`;
}

module.exports = {
  shouldBypassAlice,
  findToolDefinition,
  validateToolInput,
  validateToolCall,
  resolveRelativeDateTime,
  toolRuntimeBlock,
};
