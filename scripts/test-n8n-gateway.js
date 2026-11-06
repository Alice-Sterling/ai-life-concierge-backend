#!/usr/bin/env node
/**
 * Exercise the n8n Inbound Gateway with the seeded routing personas.
 *
 * Usage:
 *   node scripts/test-n8n-gateway.js --all
 *   node scripts/test-n8n-gateway.js --persona WaitlistUser
 *   node scripts/test-n8n-gateway.js --persona +447000000001
 *   node scripts/test-n8n-gateway.js --url https://... --all
 *
 * Reads N8N_WEBHOOK_URL from .env unless --url is provided.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const DEFAULT_BODY = 'Routing test message';
const DELAY_MS = 1000;

const TEST_CASES = [
  {
    persona: 'Unregistered',
    phone: '+447000000099',
    expected: 'unregistered_contact',
    expectedDetail: 'Unknown number should route to the invitation / access gate.',
  },
  {
    persona: 'WaitlistUser',
    phone: '+447000000001',
    expected: 'waitlist',
    expectedDetail: 'Waitlist user should receive the waitlist/status route.',
  },
  {
    persona: 'DeniedUser',
    phone: '+447000000002',
    expected: 'denied',
    expectedDetail: 'Denied user should receive the denied/status route.',
  },
  {
    persona: 'ApprovedUser',
    phone: '+447000000003',
    expected: 'approved_onboarding',
    expectedDetail: 'Approved user should receive the onboarding invitation route.',
  },
  {
    persona: 'StripeUser',
    phone: '+447000000004',
    expected: 'pending_stripe',
    expectedDetail: 'Seeded as DB phase Onboarded; should receive the payment / pending Stripe route.',
  },
  {
    persona: 'InactiveUser',
    phone: '+447000000005',
    expected: 'inactive_membership',
    expectedDetail: 'Inactive user should receive the inactive membership route.',
  },
  {
    persona: 'FirstTimeActive',
    phone: '+447000000006',
    expected: 'active_first_time',
    expectedDetail: 'Active user with welcome_message_sent=false should trigger the first active welcome path.',
  },
  {
    persona: 'OngoingActive',
    phone: '+447000000007',
    expected: 'active_ai',
    expectedDetail: 'Active user with welcome_message_sent=true should pass through to Alice / AI route.',
  },
  {
    persona: 'HumanIntercept',
    phone: '+447000000008',
    expected: 'human_intercept',
    expectedDetail: 'Active user in human conversation mode should route away from Alice to human handling.',
  },
];

function usage(exitCode = 0) {
  const names = TEST_CASES.map((t) => t.persona).join(', ');
  console.log(`Usage:
  node scripts/test-n8n-gateway.js --all
  node scripts/test-n8n-gateway.js --persona <name_or_number>
  node scripts/test-n8n-gateway.js --url <N8N_WEBHOOK_URL> --all

Options:
  --all                  Run all 9 scenarios with a 1s delay between requests.
  --persona <value>      Run one persona by name or phone number.
  --url <url>            Override N8N_WEBHOOK_URL from .env.
  --help                 Show this help.

Personas:
  ${names}
`);
  process.exit(exitCode);
}

function argValue(flag) {
  const exact = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function whatsapp(phone) {
  const p = String(phone || '').trim();
  return p.startsWith('whatsapp:') ? p : `whatsapp:${p}`;
}

function normalizeLookup(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^whatsapp:/, '')
    .replace(/[^a-z0-9+]/g, '');
}

function findPersona(value) {
  const wanted = normalizeLookup(value);
  return TEST_CASES.find((t) => {
    const phone = normalizeLookup(t.phone);
    const phoneNoPlus = phone.replace(/^\+/, '');
    return normalizeLookup(t.persona) === wanted || phone === wanted || phoneNoPlus === wanted;
  });
}

function buildPayload(testCase) {
  return {
    From: whatsapp(testCase.phone),
    Body: DEFAULT_BODY,
    ProfileName: testCase.persona,
    WaId: digitsOnly(testCase.phone),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipped(value, max = 220) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickDeep(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) return obj[key];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = pickDeep(value, keys);
      if (found != null) return found;
    }
  }
  return null;
}

function inferFromText(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('waitlist')) return 'waitlist';
  if (lower.includes('unable to offer') || lower.includes('denied')) return 'denied';
  if (lower.includes('onboarding') || lower.includes('invitation') || lower.includes('client_id=')) return 'approved_onboarding';
  if (lower.includes('payment') || lower.includes('stripe') || lower.includes('one final step')) return 'pending_stripe';
  if (lower.includes('inactive')) return 'inactive_membership';
  if (lower.includes('trial is now active') || lower.includes('welcome')) return 'active_first_time';
  if (lower.includes('human') || lower.includes('desk') || lower.includes('concierge team')) return 'human_intercept';
  if (lower.includes('alice') || lower.includes('architect')) return 'active_ai';
  if (lower.includes('access') || lower.includes('invitation only') || lower.includes('not recognised')) {
    return 'unregistered_contact';
  }
  return null;
}

function extractActual(responseText) {
  const json = tryJson(responseText);
  if (json) {
    const structured = pickDeep(json, [
      'routingOutcome',
      'routing_outcome',
      'route',
      'gatewayRoute',
      'gateway_route',
      'outcome',
      'status',
      'template',
      'template_key',
      'onboarding_phase',
      'conversation_mode',
    ]);
    if (structured != null) return String(structured);
  }
  return inferFromText(responseText) || clipped(responseText);
}

async function postTest(url, testCase) {
  const payload = buildPayload(testCase);
  const started = Date.now();
  let status = 'ERR';
  let actual = 'request_failed';
  let ok = false;
  let responsePreview = '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    status = res.status;
    const text = await res.text();
    actual = extractActual(text);
    responsePreview = clipped(text);
    ok = res.ok;
  } catch (err) {
    actual = err.message || String(err);
    responsePreview = actual;
  }

  return {
    persona: testCase.persona,
    from: payload.From,
    status,
    expected: testCase.expected,
    actual,
    http_ok: ok,
    elapsed_ms: Date.now() - started,
    response_preview: responsePreview,
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) usage(0);

  const url = argValue('--url') || process.env.N8N_WEBHOOK_URL;
  if (!url) {
    console.error('N8N_WEBHOOK_URL is not set. Add it to .env or pass --url <webhook_url>.');
    process.exit(1);
  }

  const runAll = process.argv.includes('--all');
  const personaArg = argValue('--persona');
  if (!runAll && !personaArg) usage(1);
  if (runAll && personaArg) {
    console.error('Use either --all or --persona, not both.');
    process.exit(1);
  }

  const cases = runAll ? TEST_CASES : [findPersona(personaArg)].filter(Boolean);
  if (!cases.length) {
    console.error(`No persona matched: ${personaArg}`);
    usage(1);
  }

  console.log(`n8n webhook : ${url}`);
  console.log(`scenarios   : ${cases.length}`);
  console.log('');

  const results = [];
  for (let i = 0; i < cases.length; i += 1) {
    const testCase = cases[i];
    console.log(`[${i + 1}/${cases.length}] ${testCase.persona} (${whatsapp(testCase.phone)})`);
    console.log(`  expected: ${testCase.expected} — ${testCase.expectedDetail}`);
    const result = await postTest(url, testCase);
    results.push(result);
    console.log(`  status  : ${result.status}`);
    console.log(`  actual  : ${result.actual}`);
    if (result.response_preview) console.log(`  preview : ${result.response_preview}`);
    console.log('');
    if (runAll && i < cases.length - 1) await delay(DELAY_MS);
  }

  console.table(results.map((r) => ({
    persona: r.persona,
    status: r.status,
    expected: r.expected,
    actual: r.actual,
    http_ok: r.http_ok,
    elapsed_ms: r.elapsed_ms,
  })));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
