#!/usr/bin/env node
/**
 * Seed deterministic WhatsApp personas for n8n Inbound Gateway testing.
 *
 * Usage:
 *   node scripts/seed-n8n-gateway-personas.cjs
 *   node scripts/seed-n8n-gateway-personas.cjs --dry-run
 *   node scripts/seed-n8n-gateway-personas.cjs --url-env SUPABASE_DATABASE_URL
 *   node scripts/seed-n8n-gateway-personas.cjs --prod
 *
 * By default this reads DATABASE_URL from .env/the environment. --prod uses
 * PROD_DATABASE_URL, matching scripts/apply-sql.cjs. --url-env <NAME> lets a
 * developer target SUPABASE_DATABASE_URL or another named variable explicitly.
 */

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useProd = args.includes('--prod');
const urlEnvArg = args.find((a) => a.startsWith('--url-env='));
const urlEnvIndex = args.indexOf('--url-env');
const urlEnv =
  urlEnvArg?.split('=')[1] ||
  (urlEnvIndex >= 0 ? args[urlEnvIndex + 1] : null) ||
  (useProd ? 'PROD_DATABASE_URL' : 'DATABASE_URL');

if (!urlEnv || urlEnv.startsWith('--')) {
  console.error('Usage: node scripts/seed-n8n-gateway-personas.cjs [--dry-run] [--prod] [--url-env NAME]');
  process.exit(1);
}

const databaseUrl = process.env[urlEnv];
if (!databaseUrl) {
  console.error(`${urlEnv} is not set. Add it to .env or export it before running this script.`);
  process.exit(1);
}

const unknownPhone = '+447000000099';
const canonical = (phone) => `whatsapp:${phone}`;

// The gateway's DB status is users.onboarding_phase. "Pending Stripe" is the
// product label for the existing Onboarded phase, which routes to the
// pending_stripe template in src/services/gateway.js.
const personas = [
  { phone: '+447000000001', firstName: 'WaitlistUser', requestedStatus: 'Waitlist', phase: 'Waitlist' },
  { phone: '+447000000002', firstName: 'DeniedUser', requestedStatus: 'Denied', phase: 'Denied' },
  { phone: '+447000000003', firstName: 'ApprovedUser', requestedStatus: 'Approved', phase: 'Approved' },
  { phone: '+447000000004', firstName: 'StripeUser', requestedStatus: 'Pending Stripe', phase: 'Onboarded' },
  { phone: '+447000000005', firstName: 'InactiveUser', requestedStatus: 'Inactive', phase: 'Inactive' },
  {
    phone: '+447000000006',
    firstName: 'FirstTimeActive',
    requestedStatus: 'Active',
    phase: 'Active',
    calendarConnected: true,
  },
  {
    phone: '+447000000007',
    firstName: 'OngoingActive',
    requestedStatus: 'Active',
    phase: 'Active',
    welcomeMessageSent: true,
    calendarConnected: true,
  },
  {
    phone: '+447000000008',
    firstName: 'HumanIntercept',
    requestedStatus: 'Active',
    phase: 'Active',
    welcomeMessageSent: true,
    conversationMode: 'human',
    calendarConnected: true,
  },
];

function testId(phone) {
  return `Ai-N8N${phone.slice(-3)}`;
}

function sslFor(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return { rejectUnauthorized: false };
}

async function deleteLooseRows(client, userIds) {
  if (!userIds.length) return;
  const ids = userIds.map((id) => String(id));
  await client.query('DELETE FROM conversations WHERE user_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM pending_messages WHERE user_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM outbound_messages WHERE user_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM tasks WHERE user_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM events WHERE user_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM automation_logs WHERE user_id = ANY($1::uuid[])', [ids]);
}

async function main() {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslFor(databaseUrl),
  });

  const host = (() => {
    try {
      return new URL(databaseUrl).host;
    } catch {
      return 'unknown';
    }
  })();

  console.log(`target : ${urlEnv}${useProd ? ' (--prod)' : ''}`);
  console.log(`host   : ${host}`);
  console.log(`mode   : ${dryRun ? 'DRY RUN (ROLLBACK)' : 'WRITE (COMMIT)'}`);
  console.log('');

  await client.connect();
  await client.query('BEGIN');

  try {
    const allPhones = [
      unknownPhone,
      canonical(unknownPhone),
      ...personas.flatMap((p) => [p.phone, canonical(p.phone)]),
    ];

    const removedUnknown = await client.query(
      'SELECT id FROM users WHERE phone_number = ANY($1::text[])',
      [[unknownPhone, canonical(unknownPhone)]]
    );
    await deleteLooseRows(client, removedUnknown.rows.map((r) => r.id));
    await client.query('DELETE FROM users WHERE phone_number = ANY($1::text[])', [
      [unknownPhone, canonical(unknownPhone)],
    ]);

    // Canonicalize these test accounts to Twilio's inbound phone shape. If a
    // prior manual test inserted the bare +44 number, update it when possible;
    // otherwise remove the duplicate bare row so one inbound message maps to
    // one deterministic user.
    for (const persona of personas) {
      await client.query(
        `UPDATE users
            SET phone_number = $2
          WHERE phone_number = $1
            AND NOT EXISTS (SELECT 1 FROM users WHERE phone_number = $2)`,
        [persona.phone, canonical(persona.phone)]
      );

      const duplicateBare = await client.query(
        'SELECT id FROM users WHERE phone_number = $1',
        [persona.phone]
      );
      await deleteLooseRows(client, duplicateBare.rows.map((r) => r.id));
      await client.query('DELETE FROM users WHERE phone_number = $1', [persona.phone]);
    }

    const seeded = [];
    for (const persona of personas) {
      const isActive = persona.phase === 'Active';
      const calendarConnected = Boolean(persona.calendarConnected);
      const conversationMode = persona.conversationMode || 'ai';
      const welcomeMessageSent = Boolean(persona.welcomeMessageSent);
      const id = testId(persona.phone);

      const { rows } = await client.query(
        `INSERT INTO users (
           phone_number, first_name, last_name, tier, client_id, short_id,
           subscription_status, onboarding_status, onboarding_step,
           onboarding_phase, welcome_message_sent, conversation_mode,
           conversation_mode_changed_at, calendar_connected, calendar_connected_at,
           calendar_provider, calendar_timezone, active_timezone, activated_at,
           trial_start_date
         )
         VALUES (
           $1, $2, NULL, 'lite', $3, $3,
           'LITE', $4, $5,
           $6, $7, $8::conversation_mode,
           $9, $10, $11,
           $12, $13, 'Europe/London', $14,
           $15
         )
         ON CONFLICT (phone_number) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           tier = EXCLUDED.tier,
           client_id = EXCLUDED.client_id,
           short_id = EXCLUDED.short_id,
           subscription_status = EXCLUDED.subscription_status,
           onboarding_status = EXCLUDED.onboarding_status,
           onboarding_step = EXCLUDED.onboarding_step,
           onboarding_phase = EXCLUDED.onboarding_phase,
           welcome_message_sent = EXCLUDED.welcome_message_sent,
           conversation_mode = EXCLUDED.conversation_mode,
           conversation_mode_changed_at = EXCLUDED.conversation_mode_changed_at,
           calendar_connected = EXCLUDED.calendar_connected,
           calendar_connected_at = EXCLUDED.calendar_connected_at,
           calendar_provider = EXCLUDED.calendar_provider,
           calendar_timezone = EXCLUDED.calendar_timezone,
           active_timezone = EXCLUDED.active_timezone,
           activated_at = EXCLUDED.activated_at,
           trial_start_date = EXCLUDED.trial_start_date
         RETURNING id, phone_number, first_name, onboarding_phase, welcome_message_sent,
                   conversation_mode, calendar_connected`,
        [
          canonical(persona.phone),
          persona.firstName,
          id,
          isActive ? 'complete' : 'pending',
          isActive || persona.phase === 'Onboarded' ? 8 : 1,
          persona.phase,
          welcomeMessageSent,
          conversationMode,
          conversationMode === 'human' ? new Date() : null,
          calendarConnected,
          calendarConnected ? new Date() : null,
          calendarConnected ? 'test' : null,
          calendarConnected ? 'Europe/London' : null,
          isActive ? new Date() : null,
          isActive ? new Date() : null,
        ]
      );

      seeded.push({
        ...rows[0],
        requested_status: persona.requestedStatus,
        client_id: id,
      });
    }

    await deleteLooseRows(client, seeded.map((r) => r.id));

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.table([
      { phone_number: canonical(unknownPhone), action: 'removed if present' },
      ...seeded.map((r) => ({
        phone_number: r.phone_number,
        name: r.first_name,
        requested_status: r.requested_status,
        db_onboarding_phase: r.onboarding_phase,
        welcome_message_sent: r.welcome_message_sent,
        conversation_mode: r.conversation_mode,
        calendar_connected: r.calendar_connected,
        client_id: r.client_id,
      })),
    ]);

    if (dryRun) {
      console.log('\nDry run complete. No changes were committed.');
    } else {
      console.log('\nSeed complete.');
    }
    console.log('Note: requested status "Pending Stripe" is seeded as DB phase "Onboarded",');
    console.log('which is what the current gateway uses to route to the pending_stripe template.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures so the original error is visible
    }
    console.error(`\nFAILED: ${err.message}`);
    console.error('No changes were committed.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
