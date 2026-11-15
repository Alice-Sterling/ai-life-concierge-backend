/**
 * Cancel, pause and the retention gift, inside WhatsApp (Project 4, section 7).
 *
 * The brief: when a member wants to leave, Alice never argues. She offers one
 * free month, or a 30/60-day pause, or an immediate cancellation, and does
 * what the client picks.
 *
 * These tools move real money, so two things are enforced here in code rather
 * than left to the model's manners:
 *
 *   1. Offer first. apply_free_month / pause_membership / cancel_membership
 *      only work after retention_offer was made in the last 48 hours. A stray
 *      "cancel that" about a dinner booking cannot close an account.
 *   2. Say only what happened. Each tool returns the exact words for Alice,
 *      and they differ when Stripe could not be changed: she never says a
 *      subscription was cancelled when the desk still has to do it.
 *
 * Every change is three writes: Stripe (when possible), Postgres, and a task
 * for the desk (mirrored to Airtable), plus an email for a pause or a
 * cancellation. If Stripe is not configured, has no subscription for this
 * client, or refuses, Postgres still changes and the task says, in capitals,
 * that billing must be done by hand.
 *
 * The whole feature is behind MEMBERSHIP_TOOLS_ENABLED (off by default).
 * Database columns: migration 009.
 */

const db = require('../db/pool');
const users = require('./users');
const tasks = require('./tasks');
const events = require('./events');
const email = require('../integrations/email');
const stripeIntegration = require('../integrations/stripe');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const DESK_EMAIL = 'assist@ailifeconcierge.co.uk';
const DAY_S = 86400;
const PAUSE_DAYS = [30, 60];
const FREE_MONTH_DAYS = 30;
/** Subscription states that are still a live membership. */
const LIVE = ['trialing', 'active', 'past_due', 'unpaid', 'paused'];

const RETENTION_OFFER_TOOL = {
  name: 'retention_offer',
  description:
    'The client has said they want to cancel, pause, stop or close their membership or subscription. '
    + 'Call this FIRST, before anything else. It returns the exact message to send them, with the three '
    + 'options (a free month, a pause, or cancelling now). Send that message as it is and wait for their answer.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const APPLY_FREE_MONTH_TOOL = {
  name: 'apply_free_month',
  description:
    'The client accepted the complimentary month after retention_offer. Applies it and returns the exact '
    + 'message to send. Only after retention_offer.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const PAUSE_MEMBERSHIP_TOOL = {
  name: 'pause_membership',
  description:
    'The client chose to pause after retention_offer. Pauses billing and proactive messages for 30 or 60 '
    + 'days, keeps their preferences, and returns the exact message to send. Only after retention_offer.',
  input_schema: {
    type: 'object',
    properties: { days: { type: 'integer', enum: PAUSE_DAYS, description: '30 or 60. Use 30 if they did not say.' } },
    required: ['days'],
  },
};

const CANCEL_MEMBERSHIP_TOOL = {
  name: 'cancel_membership',
  description:
    'The client insisted on cancelling after retention_offer. Cancels the membership now and returns the '
    + 'exact message to send. Permanent. Only after retention_offer, and only when the client clearly chose to cancel.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const TOOLS = [RETENTION_OFFER_TOOL, APPLY_FREE_MONTH_TOOL, PAUSE_MEMBERSHIP_TOOL, CANCEL_MEMBERSHIP_TOOL];
const has = (name) => TOOLS.some((t) => t.name === name);

/** On for everyone with the switch; the test accounts always have it, to try it on a real phone. */
function enabledFor(userId) {
  if (config.membership.enabled) return true;
  return config.testTools.userIds.includes(String(userId || '').toLowerCase());
}
const definitionsFor = (userId) => (enabledFor(userId) ? TOOLS : []);

/** The brief's protocol, for Alice's system prompt. Empty when the tools are off. */
function promptBlock(userId) {
  if (!enabledFor(userId)) return '';
  return `
### CANCELLATION & RETENTION PROTOCOL
If the client says they want to cancel, pause, stop or close their membership:
1. Never argue, refuse, or make it complicated. Keep a warm, polished, quiet-luxury tone.
2. Call retention_offer first and send the message it returns, word for word. It holds the three options.
3. When they answer, call the matching tool at once: apply_free_month, pause_membership (30 or 60 days) or cancel_membership.
4. Send the message that tool returns, word for word. It says exactly what was done. Add nothing about billing that it does not say.
A request to cancel a booking, a table, a car or a plan is NOT a membership cancellation: handle it as usual.
`;
}

const firstName = (user) => String(user?.first_name || '').trim().split(/\s+/)[0] || 'there';

const SCRIPTS = {
  offer: (u) => `I completely understand, ${firstName(u)}, and I am deeply sorry to see you go. Your time and peace of mind are my highest priorities.\n\n`
    + 'Before I process your cancellation, I would love to cover your next 30 days of membership on us, completely free, with no commitment, so you can let me take care of your schedule during busy weeks.\n\n'
    + 'Alternatively, I can pause your membership for 30 or 60 days so your preferences stay saved, or I can process your permanent cancellation right now. How would you prefer to proceed?',
  freeMonth: {
    done: () => "Wonderful. I've applied your complimentary month. Your membership will remain fully active with zero charge for the next 30 days. What can I take care of for you today?",
    manual: () => 'Wonderful. Your complimentary month is noted and your membership stays fully active. The team will confirm the billing adjustment here shortly. What can I take care of for you today?',
    already: () => 'Your complimentary month has already been applied to your membership. I can pause your membership for 30 or 60 days, or process your cancellation. How would you prefer to proceed?',
  },
  pause: {
    done: (days) => `Your membership has been safely paused for ${days} days. Your lifestyle preferences are stored securely, and no charges will occur. Whenever you're ready to reactivate, simply send me a message here. Wishing you a wonderful month.`,
    manual: (days) => `Your membership is paused for ${days} days and your lifestyle preferences are stored securely. The team will confirm the billing pause here shortly. Whenever you're ready to reactivate, simply send me a message here.`,
  },
  cancel: {
    done: () => 'Your account and recurring services have been successfully closed, and your Stripe subscription has been cancelled. It has been an absolute privilege serving you. Should your lifestyle needs ever require an executive concierge again, our door is always open.',
    manual: () => 'Your account and recurring services have been closed. The team will confirm the cancellation of your billing here shortly. It has been an absolute privilege serving you. Should your lifestyle needs ever require an executive concierge again, our door is always open.',
  },
  pausedNotice: (u, until) => `Your membership is paused${until ? ` until ${new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : ''}, ${firstName(u)}, and your preferences are safe. Reply RESUME whenever you would like to reactivate.`,
  welcomeBack: (u) => `Welcome back, ${firstName(u)}. Your membership is active again and everything is as you left it. What can I take care of for you today?`,
};

/** A reply from a paused member that means "switch me back on". */
const RESUME_REQUEST = /\b(resume|reactivate|re-activate|unpause|un-pause|restart|start again|switch (me|it) back on|i'?m back|i am back)\b/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The membership columns of one client. Null when migration 009 is not applied. */
async function getState(userId, log = logger) {
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, phone_number, email, client_id, short_id, onboarding_phase,
              account_status, active_automations, paused_automations, membership_paused_until,
              free_month_applied_at, stripe_customer_id, stripe_subscription_id, trial_duration_days
         FROM users WHERE id = $1`, [userId], log);
    return rows[0] || null;
  } catch (err) {
    log.warn('membership.state_unavailable', { message: err.message, code: err.code });
    return null;
  }
}

/** Was the retention offer made to this client recently? */
async function offerIsFresh(userId, log = logger) {
  const { rows } = await db.query(
    `SELECT 1 FROM events
      WHERE user_id = $1 AND event_name = 'retention_offer_made'
        AND timestamp > NOW() - make_interval(hours => $2::int)
      LIMIT 1`, [userId, config.membership.offerValidHours], log);
  return rows.length > 0;
}

const offerFirst = (user) => JSON.stringify({
  ok: false,
  error: 'offer_first',
  instruction: 'Nothing was changed. The three options have not been offered yet. Send this message as it is and wait for the answer.',
  say: SCRIPTS.offer(user),
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * The client's live Stripe subscription.
 * Stored ids first; for clients from before the ids were stored, their email
 * finds the customer. What is found is saved for next time.
 *
 * @returns {Promise<{subscription: object}|{reason: string}>}
 */
async function findSubscription(state, log = logger) {
  const stripe = stripeIntegration.client;
  if (!stripe) return { reason: 'not_configured' };
  try {
    if (state.stripe_subscription_id) {
      const sub = await stripe.subscriptions.retrieve(state.stripe_subscription_id);
      if (sub && LIVE.includes(sub.status)) return { subscription: sub };
    }
    let customerId = state.stripe_customer_id || null;
    if (!customerId && state.email) {
      const found = await stripe.customers.list({ email: String(state.email).trim().toLowerCase(), limit: 3 });
      // Two customers with one email: do not guess whose billing to change.
      if ((found.data || []).length > 1) return { reason: 'ambiguous_customer' };
      customerId = found.data?.[0]?.id || null;
    }
    if (!customerId) return { reason: 'not_found' };

    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    const live = (subs.data || []).filter((s) => LIVE.includes(s.status));
    if (live.length === 0) return { reason: 'not_found' };
    if (live.length > 1) return { reason: 'ambiguous_subscription' };

    await db.query(
      'UPDATE users SET stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $1',
      [state.id, customerId, live[0].id], log);
    return { subscription: live[0] };
  } catch (err) {
    log.warn('membership.stripe_lookup_failed', { user_id: state.id, message: err.message, type: err.type });
    return { reason: 'stripe_error', detail: err.message };
  }
}

/** Run one Stripe change. @returns {Promise<{stripe: 'done'}|{stripe: 'manual', reason: string}>} */
async function withStripe(state, change, log = logger) {
  const found = await findSubscription(state, log);
  if (!found.subscription) return { stripe: 'manual', reason: found.reason };
  try {
    const detail = await change(stripeIntegration.client, found.subscription);
    if (detail && detail.manual) return { stripe: 'manual', reason: detail.manual };
    return { stripe: 'done', subscription_id: found.subscription.id, ...(detail || {}) };
  } catch (err) {
    // A restricted key without write permission lands here, as does any refusal.
    log.error('membership.stripe_change_failed', { user_id: state.id, message: err.message, type: err.type, code: err.code });
    return { stripe: 'manual', reason: 'stripe_refused', detail: err.message };
  }
}

const STRIPE_REASONS = {
  not_configured: 'Stripe is not configured in the backend',
  not_found: 'no live Stripe subscription was found for this client',
  ambiguous_customer: 'more than one Stripe customer has this email',
  ambiguous_subscription: 'this client has more than one live Stripe subscription',
  stripe_error: 'Stripe could not be read',
  stripe_refused: 'Stripe refused the change (the key may not be allowed to change subscriptions)',
  no_coupon: 'the subscription is past its trial and STRIPE_FREE_MONTH_COUPON_ID is not set',
};

// ---------------------------------------------------------------------------
// Desk record
// ---------------------------------------------------------------------------

async function tellDesk(state, { title, detail, stripe, notify = false, requestId = null }, log = logger) {
  const name = [state.first_name, state.last_name].filter(Boolean).join(' ') || 'Unknown';
  const billing = stripe.stripe === 'done'
    ? `Stripe: done (subscription ${stripe.subscription_id}).`
    : `STRIPE WAS NOT CHANGED: ${STRIPE_REASONS[stripe.reason] || stripe.reason}. DO IT BY HAND.`;
  const summary = `MEMBERSHIP: ${title}\nClient: ${name} (${state.phone_number || ''}, ${state.short_id || state.client_id || ''})\n${detail}\n${billing}`;

  const task = await tasks.create({
    userId: state.id,
    sourceMessage: null,
    aiSummary: summary,
    category: 'general',
    priority: stripe.stripe === 'done' ? 'normal' : 'high',
    requiresHuman: stripe.stripe !== 'done',
    assignedTo: DESK_EMAIL,
    requestId,
  }, log);

  if ((notify || stripe.stripe !== 'done') && email.isConfigured()) {
    try {
      await email.send({
        to: DESK_EMAIL,
        subject: `MEMBERSHIP: ${title} - ${name}${stripe.stripe === 'done' ? '' : ' (BILLING NEEDS YOU)'}`,
        text: `${summary}\n\nTask ID: ${task?.task_id || ''}\nRequest ID: ${requestId || ''}`,
      }, log);
    } catch (err) {
      log.warn('membership.desk_email_failed', { message: err.message });
    }
  }
  return task;
}

/** Push the client's row to Airtable after a status change made here. */
async function mirror(userId, log = logger) {
  const row = await users.findById(userId, log);
  if (row) await users.pushToAirtable(row, log);
}

// ---------------------------------------------------------------------------
// The four actions
// ---------------------------------------------------------------------------

/** Step 1: record that the options were offered, and hand Alice the words. */
async function offer(userId, { requestId = null } = {}, log = logger) {
  const state = await getState(userId, log);
  if (!state) return JSON.stringify({ ok: false, error: 'unavailable', instruction: 'Hand this to the team with handoff_to_concierge.' });
  await events.record('retention_offer_made', { userId, requestId }, log);
  log.info('membership.offer_made', { user_id: userId });
  return JSON.stringify({ ok: true, instruction: 'Send this message as it is, then wait for their choice.', say: SCRIPTS.offer(state) });
}

/** Path 1: one complimentary month, once per client. */
async function applyFreeMonth(userId, { requestId = null } = {}, log = logger) {
  const state = await getState(userId, log);
  if (!state) return JSON.stringify({ ok: false, error: 'unavailable', instruction: 'Hand this to the team with handoff_to_concierge.' });
  if (!(await offerIsFresh(userId, log))) return offerFirst(state);
  if (state.free_month_applied_at) {
    return JSON.stringify({ ok: false, error: 'already_applied', instruction: 'Send this message as it is.', say: SCRIPTS.freeMonth.already() });
  }

  // Claim it before touching Stripe: two messages at once must not give two months.
  const { rowCount } = await db.query(
    `UPDATE users SET free_month_applied_at = NOW(),
                      trial_duration_days = trial_duration_days + $2::int
      WHERE id = $1 AND free_month_applied_at IS NULL`, [userId, FREE_MONTH_DAYS], log);
  if (rowCount === 0) {
    return JSON.stringify({ ok: false, error: 'already_applied', instruction: 'Send this message as it is.', say: SCRIPTS.freeMonth.already() });
  }

  const stripe = await withStripe(state, async (client, sub) => {
    if (sub.status === 'trialing' && sub.trial_end) {
      // Still in the trial: the trial simply ends 30 days later.
      await client.subscriptions.update(sub.id, {
        trial_end: sub.trial_end + FREE_MONTH_DAYS * DAY_S, proration_behavior: 'none',
      });
      return { how: 'trial_extended' };
    }
    if (!config.membership.freeMonthCouponId) return { manual: 'no_coupon' };
    await client.subscriptions.update(sub.id, { discounts: [{ coupon: config.membership.freeMonthCouponId }] });
    return { how: 'coupon_applied' };
  }, log);

  await events.logAutomation('retention_free_month_applied', stripe.stripe === 'done' ? 'success' : 'pending',
    { userId, requestId, errorDetails: stripe.stripe === 'done' ? null : stripe.reason }, log);
  await tellDesk(state, {
    title: 'Retention: 1 month free applied', stripe, requestId,
    detail: 'The client asked to cancel and accepted the complimentary 30 days. The membership stays Active.',
  }, log);
  log.info('membership.free_month', { user_id: userId, stripe: stripe.stripe, reason: stripe.reason || null });

  return JSON.stringify({
    ok: true, stripe: stripe.stripe, instruction: 'Send this message as it is.',
    say: stripe.stripe === 'done' ? SCRIPTS.freeMonth.done() : SCRIPTS.freeMonth.manual(),
  });
}

/** Path 2: pause for 30 or 60 days. */
async function pause(userId, { days, requestId = null } = {}, log = logger) {
  const state = await getState(userId, log);
  if (!state) return JSON.stringify({ ok: false, error: 'unavailable', instruction: 'Hand this to the team with handoff_to_concierge.' });
  if (!(await offerIsFresh(userId, log))) return offerFirst(state);
  const n = PAUSE_DAYS.includes(Number(days)) ? Number(days) : 30;
  const until = new Date(Date.now() + n * DAY_S * 1000);

  const stripe = await withStripe(state, async (client, sub) => {
    await client.subscriptions.update(sub.id, {
      pause_collection: { behavior: 'void', resumes_at: Math.floor(until.getTime() / 1000) },
    });
  }, log);

  // Status and automations in one statement. The trigger from 008 keeps the
  // explicit 'Paused' because it arrives together with the phase change.
  await db.query(
    `UPDATE users
        SET onboarding_phase = 'Inactive',
            account_status = 'Paused',
            membership_paused_until = $2,
            paused_automations = CASE WHEN account_status = 'Paused' THEN paused_automations ELSE active_automations END,
            active_automations = '[]'::jsonb
      WHERE id = $1`, [userId, until.toISOString()], log);
  await mirror(userId, log);

  await events.record('membership_paused', { userId, requestId, metadata: { days: n, until: until.toISOString(), stripe: stripe.stripe } }, log);
  await tellDesk(state, {
    title: `Self-paused for ${n} days via WhatsApp`, stripe, notify: true, requestId,
    detail: `Paused until ${until.toISOString().slice(0, 10)}. Proactive messages are off. Preferences are kept. The client can write RESUME to come back early.`,
  }, log);
  log.info('membership.paused', { user_id: userId, days: n, stripe: stripe.stripe, reason: stripe.reason || null });

  return JSON.stringify({
    ok: true, stripe: stripe.stripe, paused_until: until.toISOString(), instruction: 'Send this message as it is.',
    say: stripe.stripe === 'done' ? SCRIPTS.pause.done(n) : SCRIPTS.pause.manual(n),
  });
}

/** Path 3: cancel now. */
async function cancel(userId, { requestId = null } = {}, log = logger) {
  const state = await getState(userId, log);
  if (!state) return JSON.stringify({ ok: false, error: 'unavailable', instruction: 'Hand this to the team with handoff_to_concierge.' });
  if (!(await offerIsFresh(userId, log))) return offerFirst(state);

  const stripe = await withStripe(state, async (client, sub) => {
    await client.subscriptions.cancel(sub.id);
  }, log);

  await db.query(
    `UPDATE users
        SET onboarding_phase = 'Inactive',
            account_status = 'Cancelled',
            membership_paused_until = NULL,
            paused_automations = NULL,
            active_automations = '[]'::jsonb
      WHERE id = $1`, [userId], log);
  // The brief: the account goes to the human desk after a cancellation.
  await users.setConversationMode(userId, 'human', { requestId, source: 'membership_cancelled' }, log);

  const clientId = state.short_id || state.client_id || state.id;
  const billing = stripe.stripe === 'done' ? 'Stripe subscription terminated.' : 'Stripe NOT changed, to be done by hand.';
  await events.record('membership_cancelled', {
    userId, requestId,
    metadata: { stripe: stripe.stripe, summary: `[AI_SUMMARY: Account Cancellation - Client ID: ${clientId} - Permanent opt-out requested. ${billing}]` },
  }, log);
  await tellDesk(state, {
    title: 'Account cancellation', stripe, notify: true, requestId,
    detail: `Permanent opt-out requested in WhatsApp. Status Cancelled, proactive messages off, conversation handed to the desk. ${billing}`,
  }, log);
  log.info('membership.cancelled', { user_id: userId, stripe: stripe.stripe, reason: stripe.reason || null });

  return JSON.stringify({
    ok: true, stripe: stripe.stripe, instruction: 'Send this message as it is. It is your last message to this client.',
    say: stripe.stripe === 'done' ? SCRIPTS.cancel.done() : SCRIPTS.cancel.manual(),
  });
}

/**
 * Back from a pause: by the client (RESUME) or because the pause ran out.
 * @returns {Promise<{resumed: boolean, stripe?: string}>}
 */
async function resume(userId, { source = 'client', requestId = null } = {}, log = logger) {
  const state = await getState(userId, log);
  if (!state || state.account_status !== 'Paused') return { resumed: false };

  const stripe = await withStripe(state, async (client, sub) => {
    await client.subscriptions.update(sub.id, { pause_collection: '' });
  }, log);

  await db.query(
    `UPDATE users
        SET onboarding_phase = 'Active',
            membership_paused_until = NULL,
            active_automations = COALESCE(paused_automations, active_automations),
            paused_automations = NULL
      WHERE id = $1`, [userId], log);
  await mirror(userId, log);
  await events.record('membership_resumed', { userId, requestId, metadata: { source, stripe: stripe.stripe } }, log);
  await tellDesk(state, {
    title: source === 'client' ? 'Reactivated by the client (RESUME)' : 'Pause ended: reactivated automatically',
    stripe, notify: stripe.stripe !== 'done', requestId,
    detail: 'Status Active again. Automations restored.',
  }, log);
  log.info('membership.resumed', { user_id: userId, source, stripe: stripe.stripe });
  return { resumed: true, stripe: stripe.stripe };
}

/**
 * A paused member wrote. Called by the front door for an Inactive client.
 * @returns {Promise<null|{text: string, resumed: boolean}>} null = not paused; the front door carries on as usual
 */
async function handlePausedMessage(user, incomingText, { requestId = null } = {}, log = logger) {
  const state = await getState(user.id, log);
  if (!state || state.account_status !== 'Paused') return null;
  if (RESUME_REQUEST.test(String(incomingText || ''))) {
    await resume(user.id, { source: 'client', requestId }, log);
    return { text: SCRIPTS.welcomeBack(state), resumed: true };
  }
  return { text: SCRIPTS.pausedNotice(state, state.membership_paused_until), resumed: false };
}

/** Lifecycle job: reactivate everyone whose pause has run out. */
async function runAutoResume(log = logger) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id FROM users
        WHERE account_status = 'Paused' AND membership_paused_until IS NOT NULL AND membership_paused_until <= NOW()
        LIMIT 100`, [], log));
  } catch (err) {
    log.warn('membership.auto_resume_unavailable', { message: err.message, code: err.code });
    return undefined;
  }
  // Nothing due is the normal case: say nothing, so the job's report stays short.
  if (rows.length === 0) return undefined;
  let resumed = 0;
  for (const r of rows) {
    const out = await resume(r.id, { source: 'pause_ended' }, log);
    if (out.resumed) resumed += 1;
  }
  if (rows.length) log.info('membership.auto_resume_done', { due: rows.length, resumed });
  return { due: rows.length, resumed };
}

/** Stripe checkout finished: remember which customer and subscription this client is. */
async function rememberStripeIds(userId, session, log = logger) {
  const customer = typeof session?.customer === 'string' ? session.customer : session?.customer?.id || null;
  const subscription = typeof session?.subscription === 'string' ? session.subscription : session?.subscription?.id || null;
  if (!customer && !subscription) return;
  try {
    await db.query(
      `UPDATE users SET stripe_customer_id = COALESCE($2, stripe_customer_id),
                        stripe_subscription_id = COALESCE($3, stripe_subscription_id)
        WHERE id = $1`, [userId, customer, subscription], log);
  } catch (err) {
    // Before migration 009 the columns are missing; the email lookup still finds the client later.
    log.warn('membership.stripe_ids_not_saved', { message: err.message, code: err.code });
  }
}

/** Run one of Alice's membership tools. Always answers with JSON text for the model. */
async function run(name, input, { userId, requestId = null } = {}, log = logger) {
  if (!has(name) || !enabledFor(userId)) return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
  const toolLog = log.child({ agent_tool: name, user_id: userId });
  try {
    if (name === 'retention_offer') return await offer(userId, { requestId }, toolLog);
    if (name === 'apply_free_month') return await applyFreeMonth(userId, { requestId }, toolLog);
    if (name === 'pause_membership') return await pause(userId, { days: input?.days, requestId }, toolLog);
    return await cancel(userId, { requestId }, toolLog);
  } catch (err) {
    toolLog.error('membership.tool_failed', { message: err.message });
    return JSON.stringify({
      ok: false, error: 'failed',
      instruction: 'Nothing was confirmed. Say the team will take care of it and call handoff_to_concierge with what the client asked for.',
    });
  }
}

module.exports = {
  TOOLS, SCRIPTS, PAUSE_DAYS, RESUME_REQUEST, STRIPE_REASONS,
  has, enabledFor, definitionsFor, promptBlock, run,
  getState, offerIsFresh, findSubscription,
  offer, applyFreeMonth, pause, cancel, resume,
  handlePausedMessage, runAutoResume, rememberStripeIds,
};
