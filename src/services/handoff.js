/**
 * Alice -> human hand-off (Project 3, Step D).
 *
 * The brief has Alice end her reply with a hidden "[TRIGGER_HUMAN_MODE]" tag
 * that something scans for. A tag in free text is fragile: the model can
 * misspell it, put it mid-sentence, or forget it, and if the scan ever misses
 * it the client sees backend code on WhatsApp.
 *
 * So the primary path is a tool, handoff_to_concierge: structured input, no
 * parsing, nothing to strip. The tag is still honoured as a fallback, and
 * always stripped, so a model that emits it anyway does no harm.
 *
 * A hand-off does three things:
 *   1. conversation_mode -> human, so Alice stops talking over the desk
 *   2. a task with the booking brief, mirrored to Airtable (Requires Human)
 *   3. an email to the desk with the client's details and the brief
 */

const users = require('./users');
const tasks = require('./tasks');
const email = require('../integrations/email');
const { logger } = require('../lib/logger');

const DESK_EMAIL = 'assist@ailifeconcierge.co.uk';

const HANDOFF_TOOL = {
  name: 'handoff_to_concierge',
  description:
    'Hand this request to the human concierge desk. You cannot make final bookings or payments. '
    + 'Call this as soon as the client explicitly picks an option, confirms a car time, or agrees '
    + 'to an itinerary, or when a request genuinely needs a human. After calling it, tell the client '
    + 'in one line that the team is taking it from here. You will stop replying until the desk '
    + 'hands the client back.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['date_night', 'client_event', 'general'],
        description: 'date_night for date nights, client_event for professional events, otherwise general.',
      },
      summary: {
        type: 'string',
        description:
          'Exact booking instructions for the desk: task type, client name, venue or vendor, '
          + 'date, time, party size, addresses, and the option the client chose. Write it so a '
          + 'person can act on it without reading the chat.',
      },
      priority: { type: 'string', enum: ['normal', 'high', 'vip'] },
    },
    required: ['category', 'summary'],
  },
};

const TAG = /\[TRIGGER_HUMAN_MODE\]/gi;
const SUMMARY_TAG = /\[AI_SUMMARY:\s*([\s\S]*?)\]/i;

/**
 * Pull the brief's text tags out of a reply.
 * @returns {{ text: string, triggered: boolean, summary: string|null }}
 */
function extractTags(reply) {
  const raw = String(reply ?? '');
  const triggered = /\[TRIGGER_HUMAN_MODE\]/i.test(raw);
  const summary = raw.match(SUMMARY_TAG)?.[1]?.trim() || null;
  const text = raw.replace(TAG, '').replace(SUMMARY_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, triggered, summary };
}

/**
 * Hand a client to the desk.
 * @returns {Promise<object>} the task
 */
async function toHuman(user, { summary, category = 'general', priority = 'high', sourceMessage = null, requestId = null, via = 'tool' }, log = logger) {
  await users.setConversationMode(user.id, 'human', { requestId, source: `alice_handoff_${via}` }, log);

  const task = await tasks.create({
    userId: user.id,
    sourceMessage,
    aiSummary: summary,
    category,
    priority,
    requiresHuman: true,
    assignedTo: DESK_EMAIL,
    requestId,
  }, log);

  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
  if (email.isConfigured()) {
    await email.send({
      to: DESK_EMAIL,
      subject: `HAND-OFF: ${name} - ${category}`,
      text: `Alice has handed a client to the desk. She will stay quiet until the client is `
        + `handed back (or after 2 hours with no activity).\n\n`
        + `Client: ${name}\nPhone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}\n`
        + `Task ID: ${task.task_id}\n\nOriginal message:\n${sourceMessage || '(not captured)'}\n\n`
        + `Brief:\n${summary}\n\nRequest ID: ${requestId || ''}`,
    }, log);
  } else {
    log.warn('handoff.email_not_configured', { task_id: task.task_id });
  }

  log.info('handoff.created', { user_id: user.id, task_id: task.task_id, category, via });
  return task;
}

module.exports = { HANDOFF_TOOL, DESK_EMAIL, extractTags, toHuman };
