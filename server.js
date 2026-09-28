/**
 * Process entry point.
 *
 * Replaces index.js. Owns the things that must happen exactly once: validating
 * configuration, opening the database, starting the cron jobs, listening, and
 * shutting down cleanly.
 *
 *   node server.js
 */

require('dotenv').config();

const { createApp } = require('./src/app');
const { config, validate } = require('./src/config');
const { logger } = require('./src/lib/logger');
const { pool } = require('./src/db/pool');
const legacy = require('./src/legacy/concierge');
const nudgeJob = require('./src/jobs/nudge');
const batcher = require('./src/services/messageBatcher');
const webhookRoutes = require('./src/routes/webhook');

async function main() {
  const { missingRequired, missingRecommended } = validate();

  if (missingRequired.length > 0) {
    // Without a database nothing works, and a process that boots into a broken
    // state is harder to diagnose than one that refuses to start.
    logger.error('boot.missing_required_config', { missing: missingRequired });
    process.exit(1);
  }
  if (missingRecommended.length > 0) {
    logger.warn('boot.missing_recommended_config', { missing: missingRecommended });
  }

  // The prototype applies init-db.sql on every boot. Kept, because it is what
  // makes a fresh Railway deploy come up with a schema. It is idempotent; the
  // MVP changes live in db/sql/ and are applied deliberately, not on boot.
  try {
    await legacy.runInitScript();
    logger.info('boot.schema_ready', {});
  } catch (err) {
    // A schema failure is usually a permissions or connectivity problem. The
    // service can still serve /health, which is how an operator finds out.
    logger.error('boot.schema_init_failed', { message: err.message });
  }

  nudgeJob.start();

  // Answers each client's burst once they stop typing, instead of replying to
  // every fragment. Disables itself and logs when Twilio cannot send, since a
  // batched reply has to go out through the API rather than the webhook.
  batcher.start(webhookRoutes.runConversationFlow, logger);

  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('boot.listening', { port: config.port, env: config.env });
  });

  /** Finish in-flight requests, then close the pool, then exit. */
  const shutdown = (signal) => async () => {
    logger.info('shutdown.started', { signal });

    // Railway sends SIGTERM and waits. If a request hangs, exit anyway rather
    // than being killed mid-write with the pool still open.
    const force = setTimeout(() => {
      logger.error('shutdown.forced', { signal });
      process.exit(1);
    }, 10_000);
    force.unref();

    batcher.stop();

    server.close(async () => {
      try {
        await pool.end();
      } catch (err) {
        logger.error('shutdown.pool_close_failed', { message: err.message });
      }
      logger.info('shutdown.complete', { signal });
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  // Log and keep serving. A stray rejection in a best-effort Airtable sync
  // should not take down the WhatsApp line.
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // An uncaught exception leaves the process in an unknown state, so this one
  // does exit; Railway restarts it.
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('boot.failed', { message: err.message, stack: err.stack });
  process.exit(1);
});
