/**
 * Anthropic client.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

const client = config.anthropic.apiKey
  ? new Anthropic({ apiKey: config.anthropic.apiKey })
  : null;

function isConfigured() {
  return Boolean(client);
}

/**
 * Probe: a one-token completion.
 *
 * There is no dedicated ping endpoint, so this is the cheapest call that proves
 * the key is valid and the service is reachable. It costs a fraction of a penny,
 * which is why /health/integrations should not be polled aggressively.
 */
async function healthCheck() {
  if (!client) return { status: 'not_configured', configured: false };
  const startedAt = Date.now();
  try {
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { status: 'ok', configured: true, latency_ms: Date.now() - startedAt };
  } catch (err) {
    // A 400 still proves the key authenticated and the service answered.
    const authFailed = err.status === 401 || err.status === 403;
    return {
      status: authFailed ? 'error' : 'degraded',
      configured: true,
      latency_ms: Date.now() - startedAt,
      error: err.message,
    };
  }
}

module.exports = { client, isConfigured, healthCheck };
