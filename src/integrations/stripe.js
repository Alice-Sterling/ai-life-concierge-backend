/**
 * Stripe client and webhook signature verification.
 */

const Stripe = require('stripe');
const { config } = require('../config');

const client = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

function isConfigured() {
  return Boolean(client);
}

/**
 * Verify and parse a Stripe webhook.
 *
 * `rawBody` must be the unparsed Buffer: Stripe signs the exact bytes, so any
 * JSON round-trip invalidates the signature. The webhook route therefore mounts
 * express.raw() and must sit above express.json().
 *
 * @throws if the signature does not verify
 */
function constructEvent(rawBody, signature) {
  if (!client) throw Object.assign(new Error('Stripe is not configured'), { status: 503 });
  if (!config.stripe.webhookSecret) {
    throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET is not set'), { status: 503 });
  }
  return client.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/** Probe: list a single price. Read-only. */
async function healthCheck() {
  if (!client) return { status: 'not_configured', configured: false };
  const startedAt = Date.now();
  try {
    await client.prices.list({ limit: 1 });
    return {
      status: 'ok',
      configured: true,
      latency_ms: Date.now() - startedAt,
      webhook_secret_configured: Boolean(config.stripe.webhookSecret),
    };
  } catch (err) {
    return {
      status: 'error',
      configured: true,
      latency_ms: Date.now() - startedAt,
      error: err.message,
      webhook_secret_configured: Boolean(config.stripe.webhookSecret),
    };
  }
}

module.exports = { client, isConfigured, constructEvent, healthCheck };
