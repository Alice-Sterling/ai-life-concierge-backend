/**
 * Twilio webhook signature: accepted when Twilio signed PUBLIC_BASE_URL or the
 * domain the request arrived on; refused for a wrong signature or token.
 * No network, no database. Run: node tests/twilio-signature.cjs
 */
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-auth-token';

const { getExpectedTwilioSignature } = require('twilio/lib/webhooks/webhooks');
const { config } = require('../src/config');
const twilio = require('../src/integrations/twilio');

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`);
}

const TOKEN = 'test-auth-token';
config.twilio.authToken = TOKEN;
config.publicBaseUrl = 'https://go.example.co.uk';

const body = { From: 'whatsapp:+447700900000', Body: 'hello', MessageSid: 'SM00000000000000000000000000000000' };

/** A fake Express request that arrived on `host` and was signed for `signedUrl`. */
function request(host, signedUrl, { token = TOKEN, proto = 'https' } = {}) {
  const headers = {
    'x-forwarded-proto': proto,
    host,
    'x-twilio-signature': signedUrl ? getExpectedTwilioSignature(token, signedUrl, body) : '',
  };
  return { originalUrl: '/webhook', protocol: 'http', body, get: (name) => headers[name.toLowerCase()] };
}

const OLD = 'old-backend.up.railway.app';

check('signed for PUBLIC_BASE_URL, arrived on the custom domain',
  twilio.validateSignature(request('go.example.co.uk', 'https://go.example.co.uk/webhook')), true);
check('signed for the Railway domain it arrived on (webhook not moved yet)',
  twilio.validateSignature(request(OLD, `https://${OLD}/webhook`)), true);
check('signed for PUBLIC_BASE_URL, arrived on the Railway domain',
  twilio.validateSignature(request(OLD, 'https://go.example.co.uk/webhook')), true);
check('signed for another domain entirely is refused',
  twilio.validateSignature(request(OLD, 'https://evil.example.com/webhook')), false);
check('signed with the wrong auth token is refused',
  twilio.validateSignature(request(OLD, `https://${OLD}/webhook`, { token: 'wrong-token' })), false);
check('no signature is refused',
  twilio.validateSignature(request(OLD, null)), false);
check('a list in X-Forwarded-Proto uses the first entry',
  twilio.validateSignature(request(OLD, `https://${OLD}/webhook`, { proto: 'https, http' })), true);

config.publicBaseUrl = '';
check('without PUBLIC_BASE_URL the arrival domain still works',
  twilio.validateSignature(request(OLD, `https://${OLD}/webhook`)), true);

config.twilio.authToken = '';
check('no auth token configured is refused',
  twilio.validateSignature(request(OLD, `https://${OLD}/webhook`)), false);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
process.exit(0);
