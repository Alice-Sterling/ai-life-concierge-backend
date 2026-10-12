/**
 * Auto-resume (Project 3, Step E).
 *
 * A client handed to the desk is in 'human' mode, and Alice stays silent. If
 * nobody on the desk switches them back, they are stranded: every message is
 * queued and nobody answers. This job hands anyone back to Alice once the
 * hand-off has been quiet for HUMAN_MODE_TIMEOUT_MINUTES (default 120).
 *
 * Set HUMAN_MODE_TIMEOUT_MINUTES=0 to switch it off.
 */

const cron = require('node-cron');
const users = require('../services/users');
const events = require('../services/events');
const { config } = require('../config');
const { logger } = require('../lib/logger');

async function runSweep(log = logger) {
  const minutes = config.gate.humanModeTimeoutMinutes;
  const stale = await users.findStaleHumanMode(minutes, log);

  for (const u of stale) {
    await users.setConversationMode(u.id, 'ai', { source: 'auto_resume' }, log);
    await events.record('human_mode_auto_resumed', { userId: u.id, metadata: { after_minutes: minutes } }, log);
  }

  if (stale.length) log.info('cron.human_mode_resumed', { count: stale.length, after_minutes: minutes });
  return { resumed: stale.length };
}

/** Register the schedule. Called once from server.js. */
function start() {
  if (!(config.gate.humanModeTimeoutMinutes > 0)) {
    logger.info('cron.human_mode_resume_disabled', {});
    return null;
  }
  const schedule = process.env.HUMAN_MODE_RESUME_CRON || '*/10 * * * *';
  logger.info('cron.human_mode_resume_started', { schedule, after_minutes: config.gate.humanModeTimeoutMinutes });

  let running = false;
  return cron.schedule(schedule, async () => {
    if (running) return;
    running = true;
    try {
      await runSweep(logger);
    } catch (err) {
      logger.error('cron.human_mode_resume_failed', { message: err.message });
    } finally {
      running = false;
    }
  });
}

module.exports = { start, runSweep };
