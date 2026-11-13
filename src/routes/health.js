/**
 * Health endpoints.
 *
 *   GET /health               liveness. No I/O. Safe for Railway's health probe.
 *   GET /health/integrations  connectivity to every external dependency.
 *   GET /health/airtable-schema  the Airtable tables and fields the backend
 *                             depends on still exist (also checked at boot).
 *
 * /health/integrations makes real network calls, including a metered Anthropic
 * request, so it is not the endpoint to point an uptime monitor at. Use /health
 * for that.
 */

const express = require('express');
const { config, validate } = require('../config');
const db = require('../db/pool');
const twilio = require('../integrations/twilio');
const anthropic = require('../integrations/anthropic');
const email = require('../integrations/email');
const airtable = require('../integrations/airtable');
const stripeClient = require('../integrations/stripe');
const transcription = require('../integrations/transcription');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ai-life-concierge',
    env: config.env,
    uptime_s: Math.round(process.uptime()),
    request_id: req.requestId,
  });
});

router.get('/health/integrations', async (req, res) => {
  const startedAt = Date.now();

  // Run every probe concurrently: sequentially this would take as long as the
  // sum of the slowest third-party APIs.
  const names = ['postgres', 'twilio', 'anthropic', 'sendgrid', 'airtable', 'stripe'];
  const settled = await Promise.allSettled([
    db.healthCheck(),
    twilio.healthCheck(),
    anthropic.healthCheck(),
    email.healthCheck(),
    airtable.healthCheck(),
    stripeClient.healthCheck(),
  ]);
  // No network call: reports whether a Whisper key is set. Kept out of the
  // overall status, because voice notes without a key are a choice, not a fault.
  const voiceNotes = transcription.healthCheck();

  const integrations = {};
  settled.forEach((result, i) => {
    integrations[names[i]] = result.status === 'fulfilled'
      ? result.value
      // A probe that throws is itself a finding; report it rather than 500 the
      // whole endpoint and lose the other five results.
      : { status: 'error', error: result.reason?.message ?? 'probe threw' };
  });

  const { missingRequired, missingRecommended } = validate();

  // Anything genuinely broken makes the whole report unhealthy. 'not_configured'
  // is a deliberate deployment choice, not a fault, so it only downgrades.
  const values = Object.values(integrations);
  const status = values.some((i) => i.status === 'error') || missingRequired.length > 0
    ? 'unhealthy'
    : values.some((i) => i.status === 'degraded' || i.status === 'not_configured')
      ? 'degraded'
      : 'ok';

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    request_id: req.requestId,
    integrations,
    voice_notes: voiceNotes,
    config: { missing_required: missingRequired, missing_recommended: missingRecommended },
  });
});

/**
 * Has anyone renamed or deleted an Airtable table or field the backend uses?
 *
 * Airtable is edited by hand, and a renamed column makes a sync fail without
 * any error the desk would see. 200 = everything is there; 503 = something is
 * missing, with the list. The answer is cached for five minutes (?fresh=1
 * checks again), so a monitor can poll it without spending the Airtable quota.
 */
const SCHEMA_CACHE_MS = 5 * 60_000;
let schemaCache = { at: 0, result: null };

router.get('/health/airtable-schema', async (req, res) => {
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  if (fresh || !schemaCache.result || Date.now() - schemaCache.at > SCHEMA_CACHE_MS) {
    try {
      schemaCache = { at: Date.now(), result: await airtable.schemaCheck(req.log) };
    } catch (err) {
      schemaCache = { at: Date.now(), result: { status: 'error', problems: [err.message] } };
    }
  }
  const { result, at } = schemaCache;
  res.status(result.status === 'error' ? 503 : 200).json({
    ...result,
    checked_at: new Date(at).toISOString(),
    cached: !fresh && Date.now() - at > 1000,
    request_id: req.requestId,
  });
});

module.exports = router;
