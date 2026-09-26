/**
 * Apply a .sql file to the database in one connection.
 *
 * Railway's Data tab is a table browser, not a SQL console: it runs a single
 * statement and appends its own LIMIT, so a multi-statement DDL script fails
 * with "syntax error at or near LIMIT". This runs the file as one script, the
 * way psql would.
 *
 * Intended to be run as a one-off command on the Railway service, where
 * DATABASE_URL is already set and the connection stays on the private network:
 *
 *   npm run db:apply db/sql/001_mvp_schema_up.sql
 *   npm run db:apply db/sql/002_verify.sql
 *
 * The up script is wrapped in BEGIN/COMMIT, so a failure anywhere rolls the
 * whole thing back. There is no half-applied state to clean up.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-sql.cjs <path-to.sql>');
  process.exit(1);
}

const full = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
if (!fs.existsSync(full)) {
  console.error(`No such file: ${full}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

(async () => {
  const client = new Client({
    connectionString: url,
    // Railway's managed Postgres uses a self-signed certificate.
    ssl: url.includes('railway') || url.startsWith('postgres://')
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();

  const host = (() => { try { return new URL(url).host; } catch { return 'unknown'; } })();
  console.log(`host   : ${host}`);
  console.log(`file   : ${path.relative(process.cwd(), full)}`);
  console.log('');

  const sql = fs.readFileSync(full, 'utf8');
  const started = Date.now();

  try {
    const result = await client.query(sql);

    // A verify script returns rows; a DDL script does not. Print whatever came
    // back so 002_verify.sql is readable without a second tool.
    const sets = Array.isArray(result) ? result : [result];
    for (const set of sets) {
      if (set?.rows?.length) console.table(set.rows);
    }

    console.log(`\nOK  (${Date.now() - started}ms)`);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    if (err.position) console.error(`at character ${err.position}`);
    console.error('\nNothing was changed: the script is wrapped in a transaction.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
