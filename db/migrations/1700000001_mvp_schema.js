/* eslint-disable camelcase */

/**
 * MVP schema: the users columns, plus the tasks, events and automation_logs
 * tables. Brief sections 2A-2D.
 *
 * This migration deliberately executes the files in db/sql/ rather than
 * restating the schema in the pgm API. The same change has to be applicable two
 * ways — through node-pg-migrate, and by hand in a Railway console — and two
 * hand-maintained copies of a schema drift apart. db/sql/ is the single source
 * of truth; this is a thin wrapper so `npm run migrate:up` stays available.
 *
 * Both scripts carry their own BEGIN/COMMIT, so a failure rolls back cleanly.
 */

const fs = require('fs');
const path = require('path');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const read = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(read('001_mvp_schema_up.sql'));
};

exports.down = (pgm) => {
  // Destructive: drops tasks, events and automation_logs and everything in them.
  pgm.sql(read('001_mvp_schema_down.sql'));
};
