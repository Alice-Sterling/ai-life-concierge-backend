/**
 * Security headers and rate limiting.
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { config } = require('../config');

/**
 * Standard security headers.
 *
 * The landing page at `/` is server-rendered HTML with inline styles, so the
 * default Content-Security-Policy would blank it. CSP is therefore left off
 * here rather than shipped broken; the remaining headers (HSTS, nosniff,
 * frameguard, referrer policy) all apply.
 */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * General limiter for browser-facing routes.
 *
 * Railway terminates TLS upstream, so the client address arrives in
 * X-Forwarded-For. `app.set('trust proxy', 1)` in the app makes req.ip resolve
 * to the real caller rather than the proxy — without it every visitor shares
 * one bucket and the limiter locks out the whole site at once.
 */
function generalLimiter() {
  return rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    limit: config.security.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again shortly.' },
  });
}

/**
 * Tighter limiter for the admin API.
 *
 * These endpoints sit behind a single shared token, so the realistic attack is
 * someone guessing it. A low ceiling makes that impractical.
 */
function adminLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many admin requests.' },
  });
}

/**
 * Limiter for the Twilio webhook.
 *
 * Deliberately generous: Twilio retries and bursts legitimately, and dropping a
 * real inbound message is worse than absorbing it. The signature check is the
 * actual guard here; this only blunts a flood.
 */
function webhookLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // A 429 makes Twilio retry, which is the correct behaviour under load.
    message: 'Rate limited',
  });
}

module.exports = { securityHeaders, generalLimiter, adminLimiter, webhookLimiter };
