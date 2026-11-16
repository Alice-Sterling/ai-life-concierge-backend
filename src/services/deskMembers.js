/**
 * The Command Center team (Project 4): who may use the dashboard, and how.
 *
 *   owner   reads, replies, takes over, manages the team
 *   agent   reads, replies, takes over
 *   viewer  reads only
 *
 * The dashboard's server function asks lookup() on every call, and owners
 * change the list from the dashboard. Two rules are enforced here, not in
 * the UI: an email is stored lower-case and trimmed, and the last owner can
 * neither be removed nor demoted, so the team can never lock itself out.
 */

const db = require('../db/pool');
const { logger } = require('../lib/logger');

const ROLES = ['owner', 'agent', 'viewer'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });

function cleanEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw fail(400, 'invalid_email', 'That is not a valid email address.');
  return email;
}

async function list(log = logger) {
  const { rows } = await db.query(
    `SELECT email, role, added_by, created_at, updated_at FROM desk_members
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, email`, [], log);
  return rows;
}

/** The person's role, or null when they are not on the team. */
async function lookup(rawEmail, log = logger) {
  let email;
  try { email = cleanEmail(rawEmail); } catch { return null; }
  const { rows } = await db.query('SELECT email, role FROM desk_members WHERE email = $1', [email], log);
  return rows[0] || null;
}

/**
 * Add a person, or change their role.
 * @returns {Promise<{member: object, created: boolean}>}
 */
async function upsert({ email: rawEmail, role, addedBy = null }, log = logger) {
  const email = cleanEmail(rawEmail);
  if (!ROLES.includes(role)) throw fail(400, 'invalid_role', `role must be one of: ${ROLES.join(', ')}`);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // One change to the team at a time, so two owners demoting each other at
    // the same moment cannot both pass the "last owner" check.
    await client.query('LOCK TABLE desk_members IN SHARE ROW EXCLUSIVE MODE');
    const { rows: current } = await client.query('SELECT role FROM desk_members WHERE email = $1', [email]);
    if (current[0]?.role === 'owner' && role !== 'owner') {
      const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM desk_members WHERE role = 'owner'");
      if (rows[0].n <= 1) throw fail(409, 'last_owner', 'The team needs at least one owner. Make someone else an owner first.');
    }
    const { rows } = await client.query(
      `INSERT INTO desk_members (email, role, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
       RETURNING email, role, added_by, created_at, updated_at, (xmax = 0) AS created`,
      [email, role, addedBy ? String(addedBy).slice(0, 254) : null]);
    await client.query('COMMIT');
    const { created, ...member } = rows[0];
    log.info('desk_members.saved', { role, created, by: addedBy });
    return { member, created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Take a person off the team. @returns {Promise<boolean>} whether they were on it */
async function remove(rawEmail, { by = null } = {}, log = logger) {
  const email = cleanEmail(rawEmail);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE desk_members IN SHARE ROW EXCLUSIVE MODE');
    const { rows: current } = await client.query('SELECT role FROM desk_members WHERE email = $1', [email]);
    if (!current[0]) { await client.query('ROLLBACK'); return false; }
    if (current[0].role === 'owner') {
      const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM desk_members WHERE role = 'owner'");
      if (rows[0].n <= 1) throw fail(409, 'last_owner', 'The team needs at least one owner. Make someone else an owner first.');
    }
    await client.query('DELETE FROM desk_members WHERE email = $1', [email]);
    await client.query('COMMIT');
    log.info('desk_members.removed', { by });
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ROLES, cleanEmail, list, lookup, upsert, remove };
