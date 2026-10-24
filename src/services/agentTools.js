/**
 * Alice's agent tools (Project 3, "Global Master Agent").
 *
 * The brief gives Alice a toolbelt so she verifies before she pitches and
 * hands real bookings to the desk. Each tool here is an Anthropic tool
 * definition plus a handler. The rules every tool follows:
 *
 *   - It checks or prepares; it never books or pays. Bookings stay human.
 *   - When it cannot check (provider down, not configured, an error), it says
 *     so with cannotVerify() and Alice hands the request to the desk instead
 *     of guessing.
 *   - The whole set is off until AGENT_TOOLS_ENABLED, except for the test
 *     accounts (config.testTools.userIds), so it can be tried on a real phone
 *     before any client sees it.
 *
 * Tools so far:
 *   queue_local_dispatch    no car service covers the trip -> the desk arranges a local taxi
 *   submit_private_inquiry  private dining / events -> an inquiry drafted for the desk to send
 */

const users = require('./users');
const tasks = require('./tasks');
const email = require('../integrations/email');
const { DESK_EMAIL } = require('./handoff');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const QUEUE_LOCAL_DISPATCH_TOOL = {
  name: 'queue_local_dispatch',
  description:
    'Ask the human desk to arrange a local taxi or car when no car service can be quoted for the trip '
    + '(for example outside Uber coverage, or the client wants a local firm). Use it only after the client '
    + 'has confirmed the pickup, drop-off and time. The desk books it and confirms; you do not.',
  input_schema: {
    type: 'object',
    properties: {
      pickup: { type: 'string', description: 'Pickup address or place, as exact as the client gave it.' },
      dropoff: { type: 'string', description: 'Drop-off address or place.' },
      time: { type: 'string', description: "Pickup date and time in the client's local time, e.g. 'Fri 31 Oct 18:30'." },
      reason: { type: 'string', description: 'Why a local car: e.g. no Uber coverage, luggage, client preference.' },
    },
    required: ['pickup', 'dropoff', 'time'],
  },
};

const SUBMIT_PRIVATE_INQUIRY_TOOL = {
  name: 'submit_private_inquiry',
  description:
    "Send a private dining or events inquiry to a venue's events team: members' clubs, private dining "
    + 'rooms, or any table for more than 6 people. Do NOT check live availability for these. The inquiry '
    + 'is drafted for the concierge desk, who send it to the venue and come back with the answer. Use it '
    + 'once the client has given the venue, the date and the number of guests.',
  input_schema: {
    type: 'object',
    properties: {
      venue: { type: 'string', description: 'Venue name, and area if known.' },
      date: { type: 'string', description: "Date and preferred time, in the client's local time." },
      guest_count: { type: 'integer', description: 'Number of guests, including the client.' },
      occasion: { type: 'string', description: 'Optional: client dinner, birthday, anniversary...' },
      requirements: { type: 'string', description: 'Optional: private room, dietary needs, budget, wine.' },
    },
    required: ['venue', 'date', 'guest_count'],
  },
};

const TOOLS = [QUEUE_LOCAL_DISPATCH_TOOL, SUBMIT_PRIVATE_INQUIRY_TOOL];
const NAMES = new Set(TOOLS.map((t) => t.name));

/** Does this user get the agent tools? Everyone once switched on; test accounts always. */
function enabledFor(userId) {
  if (config.agentTools.enabled) return true;
  return config.testTools.userIds.includes(String(userId || '').toLowerCase());
}

/** The tool definitions to give Alice for this user (empty while switched off). */
function definitionsFor(userId) {
  return enabledFor(userId) ? TOOLS : [];
}

const has = (name) => NAMES.has(name);

/** The brief's tool routing matrix, for the tools that exist so far. Empty while switched off. */
function promptBlock(userId) {
  if (!enabledFor(userId)) return '';
  return `
### AGENT TOOLS (verify before you pitch)
- Members' clubs, private dining rooms, or more than 6 guests: call submit_private_inquiry. Do NOT check live availability for these.
- A car the client has confirmed that no car service can quote (no coverage, or they want a local firm): call queue_local_dispatch.
- If a tool says it could not verify, do not present options: tell the client the team will check personally and call handoff_to_concierge.
`;
}

/** The answer a tool gives when it could not check: Alice must not guess. */
function cannotVerify(reason) {
  return JSON.stringify({
    ok: false,
    verified: false,
    reason,
    instruction: 'Do not present unverified options. Tell the client the concierge team will check this '
      + 'personally, then call handoff_to_concierge with the full request.',
  });
}

const clientName = (user) => [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Client';
const clientLine = (user) =>
  `Client: ${clientName(user)}\nPhone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}`;

/** A desk task plus an email to the desk. Alice keeps talking: this is not a hand-off. */
async function deskTask(user, { subject, summary, category = 'general', priority = 'high', sourceMessage, requestId }, log) {
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

  if (email.isConfigured()) {
    await email.send({
      to: DESK_EMAIL,
      subject: `${subject}: ${clientName(user)}`,
      text: `${summary}\n\nTask ID: ${task.task_id}\nRequest ID: ${requestId || ''}`,
    }, log);
  } else {
    log.warn('agent_tool.email_not_configured', { task_id: task.task_id });
  }
  return task;
}

const HANDLERS = {
  async queue_local_dispatch(user, input, ctx, log) {
    const summary = [
      'LOCAL DISPATCH: please book a local taxi or car and confirm to the client.',
      '',
      clientLine(user),
      `Pickup: ${input.pickup}`,
      `Drop-off: ${input.dropoff}`,
      `Time: ${input.time} (client's local time${user.active_timezone ? `, ${user.active_timezone}` : ''})`,
      `Reason: ${input.reason || 'not given'}`,
    ].join('\n');
    const task = await deskTask(user, { ...ctx, subject: 'LOCAL DISPATCH', summary }, log);
    return {
      ok: true,
      task_id: task.task_id,
      note: 'The desk is arranging the car. Tell the client in one line that a local car is being '
        + 'arranged and the team will confirm the details shortly. Do not promise a price or a driver.',
    };
  },

  async submit_private_inquiry(user, input, ctx, log) {
    const guests = Number.parseInt(input.guest_count, 10);
    const draft = [
      `Subject: Private dining inquiry, ${input.date}, ${Number.isFinite(guests) ? guests : '?'} guests`,
      '',
      `Dear ${input.venue} events team,`,
      '',
      `We would like to inquire about a private booking on ${input.date} for `
        + `${Number.isFinite(guests) ? guests : 'a group of'} guests`
        + `${input.occasion ? ` (${input.occasion})` : ''}.`,
      input.requirements ? `Requirements: ${input.requirements}.` : null,
      '',
      'Could you let us know your availability, room options and minimum spend?',
      '',
      'Kind regards,',
      'Ai Life Concierge',
      DESK_EMAIL,
    ].filter((l) => l !== null).join('\n');

    const summary = [
      `PRIVATE DINING INQUIRY: please send the draft below to ${input.venue}'s events team, then update the client.`,
      '',
      clientLine(user),
      '',
      '--- Draft email ---',
      draft,
    ].join('\n');
    const task = await deskTask(user, { ...ctx, subject: 'PRIVATE INQUIRY', summary, category: 'client_event' }, log);
    return {
      ok: true,
      status: 'drafted_for_desk',
      task_id: task.task_id,
      note: "The inquiry is drafted and with the desk, who will send it to the venue's events team. "
        + 'Tell the client that, and that you will update them as soon as the venue replies. '
        + 'Do not claim the venue has confirmed anything.',
    };
  },
};

/**
 * Run one tool call for Alice.
 * @returns {Promise<string>} the tool_result content (JSON)
 */
async function run(name, input, { userId, sourceMessage = null, requestId = null } = {}, log = logger) {
  const toolLog = log.child({ agent_tool: name, user_id: userId });
  if (!has(name) || !enabledFor(userId)) return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
  try {
    const user = await users.findById(userId, toolLog);
    if (!user) return JSON.stringify({ ok: false, error: 'User not found.' });
    const result = await HANDLERS[name](user, input || {}, { sourceMessage, requestId }, toolLog);
    toolLog.info('agent_tool.done', { ok: result.ok !== false });
    return JSON.stringify(result);
  } catch (err) {
    toolLog.error('agent_tool.failed', { message: err.message });
    return cannotVerify(`The ${name} tool failed: ${err.message}`);
  }
}

module.exports = { TOOLS, enabledFor, definitionsFor, has, promptBlock, cannotVerify, run };
