/**
 * The single PostgreSQL connection pool.
 *
 * Exported as a module so every caller shares one pool. Two pools against the
 * same database quietly double the connection count, which matters on Railway's
 * smaller plans where the connection limit is low.
 */

const { Pool } = require('pg');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const pool = new Pool({
  connectionString: config.database.url,
  ssl: config.database.ssl,
});

// An idle client erroring is usually the database restarting or a network blip.
// Without a handler, pg raises it as an unhandled error event and takes the
// process down; the pool itself recovers on the next checkout.
pool.on('error', (err) => {
  logger.error('db.idle_client_error', { message: err.message });
});

/**
 * Run a query with timing and failure logging.
 *
 * @param {string} text
 * @param {Array}  [params]
 * @param {object} [log] request-bound logger, so the query is traceable to a request
 */
async function query(text, params, log = logger) {
  const startedAt = Date.now();
  try {
    return await pool.query(text, params);
  } catch (err) {
    log.error('db.query_failed', {
      message: err.message,
      code: err.code,
      duration_ms: Date.now() - startedAt,
      // The statement, not the parameters: parameters are user data.
      statement: text.replace(/\s+/g, ' ').trim().slice(0, 200),
    });
    throw err;
  }
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on throw.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function transaction(fn, log = logger) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Report it, but surface the original failure: the rollback error is a
      // symptom (usually a dead connection), not the cause.
      log.error('db.rollback_failed', { message: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Cheap liveness probe for /health/integrations. */
async function healthCheck() {
  const startedAt = Date.now();
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return {
      status: r.rows[0].ok === 1 ? 'ok' : 'degraded',
      configured: Boolean(config.database.url),
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'error',
      configured: Boolean(config.database.url),
      latency_ms: Date.now() - startedAt,
      error: err.message,
    };
  }
}

module.exports = { pool, query, transaction, healthCheck };
