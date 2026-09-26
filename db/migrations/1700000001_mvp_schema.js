/* eslint-disable camelcase */

/**
 * MVP schema, brief sections 2A-2D.
 *
 * This migration executes the files in db/sql/ rather than restating the schema
 * in the pgm API. The same change has to be applicable two ways - through
 * node-pg-migrate, and by hand in a console - and two hand-maintained copies of
 * a schema drift apart. db/sql/ is the single source of truth.
 *
 * NOTE: running this applies BOTH halves back to back, which is correct for a
 * fresh database or a maintenance window, but NOT for a live rollout. For zero
 * downtime the two halves must straddle the deploy:
 *
 *     001a_prepare.sql  ->  deploy the code  ->  001b_finalize.sql
 *
 * See README, "Deploying".
 */

const fs = require('fs');
const path = require('path');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const read = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(read('001a_prepare.sql'));
  pgm.sql(read('001b_finalize.sql'));
};

exports.down = (pgm) => {
  // Destructive: drops tasks, events and automation_logs and everything in them.
  pgm.sql(read('001_mvp_schema_down.sql'));
};
