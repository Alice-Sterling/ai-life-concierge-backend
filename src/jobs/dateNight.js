/**
 * Hourly date-night sweep.
 *
 * Finds clients whose next date night has come due and raises an operator task
 * with a ready brief. See src/services/dateNight.js for why it creates a task
 * rather than messaging the client directly.
 */

const cron = require('node-cron');
const dateNight = require('../services/dateNight');
const { logger } = require('../lib/logger');

/** Register the schedule. Called once from server.js. */
function start() {
  const schedule = process.env.DATE_NIGHT_CRON_SCHEDULE || '15 * * * *';
  logger.info('cron.date_night_started', { schedule });

  let running = false;
  return cron.schedule(schedule, async () => {
    // A slow sweep must not overlap the next tick and double-create tasks.
    if (running) return;
    running = true;
    try {
      await dateNight.runDueSweep(logger);
    } catch (err) {
      logger.error('cron.date_night_failed', { message: err.message });
    } finally {
      running = false;
    }
  });
}

module.exports = { start };
