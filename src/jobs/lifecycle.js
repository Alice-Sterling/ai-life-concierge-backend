/**
 * Lifecycle sweep, every 15 minutes: onboarding reminders, the 48-hour
 * post-activation ping, and the 4-hour nudge on unanswered options.
 *
 * Each part has its own switch (see config.lifecycle) and is skipped while
 * off, so this job can ship before any template is approved.
 */

const cron = require('node-cron');
const { config } = require('../config');
const lifecycle = require('../services/lifecycle');
const { logger } = require('../lib/logger');

/** One pass. Exported so tests and the admin can run it on demand. */
async function runOnce(log = logger) {
  const parts = [
    ['onboarding_reminders', config.lifecycle.onboardingReminder, lifecycle.runOnboardingReminders],
    ['handshake_pings', config.lifecycle.handshakePing, lifecycle.runHandshakePings],
    ['proposal_nudges', config.lifecycle.proposalNudge, lifecycle.runProposalNudges],
  ];
  const results = {};
  for (const [name, enabled, run] of parts) {
    if (!enabled) continue;
    try {
      results[name] = await run(log);
    } catch (err) {
      // One part failing must not stop the others.
      log.error(`cron.lifecycle_${name}_failed`, { message: err.message });
    }
  }
  return results;
}

/** Register the schedule. Called once from server.js. */
function start() {
  const schedule = config.lifecycle.schedule;
  logger.info('cron.lifecycle_started', {
    schedule,
    onboarding_reminder: config.lifecycle.onboardingReminder,
    handshake_ping: config.lifecycle.handshakePing,
    proposal_nudge: config.lifecycle.proposalNudge,
  });

  let running = false;
  return cron.schedule(schedule, async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(logger);
    } finally {
      running = false;
    }
  });
}

module.exports = { start, runOnce };
