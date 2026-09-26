/**
 * Express application assembly.
 *
 * Exports the configured app without starting it, so tests can drive it
 * in-process. Listening is server.js's job.
 *
 * Middleware order matters and is deliberate:
 *   1. trust proxy      - so req.ip is the caller, not Railway's edge
 *   2. raw-body routes  - Stripe signs exact bytes; must precede express.json
 *   3. request id       - everything below logs with a traceable id
 *   4. security headers
 *   5. body parsers
 *   6. routes
 *   7. 404, then the error handler
 */

const express = require('express');
const { config } = require('./config');
const { requestId } = require('./middleware/requestId');
const { securityHeaders, generalLimiter, adminLimiter } = require('./middleware/security');
const { adminAuth } = require('./middleware/adminAuth');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { webhookLimiter } = require('./middleware/security');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const stripeRoutes = require('./routes/stripe');
const webhookRoutes = require('./routes/webhook');
const portalRoutes = require('./routes/portal');

function createApp() {
  const app = express();

  // Railway terminates TLS one hop upstream. Without this, req.ip is the proxy's
  // address for every visitor, so the rate limiter treats all traffic as one
  // client. The value is 1 rather than true: trusting every hop lets a caller
  // spoof X-Forwarded-For and evade the limiter entirely.
  app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(requestId());
  app.use(securityHeaders());

  // Stripe must see the raw body, so this router is mounted before the JSON
  // parser. It brings its own express.raw().
  app.use(stripeRoutes);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Health checks sit above the rate limiter: an uptime probe must not be
  // throttled, and a 429 from /health reads as an outage.
  app.use(healthRoutes);

  // The Twilio webhook has its own, far looser limit. Behind the general
  // limiter a legitimate burst of customer messages would be dropped.
  app.use(webhookLimiter(), webhookRoutes);

  app.use(generalLimiter());

  // Permanent redirect, per the brief. 301 rather than 302 so browsers and
  // search engines stop asking. Declared before the portal router so it is not
  // shadowed by it.
  app.get('/portal', (req, res) => res.redirect(301, '/'));

  app.use('/admin', adminLimiter(), adminAuth(), adminRoutes);

  app.use(portalRoutes);

  app.use(notFound());
  app.use(errorHandler());

  return app;
}

module.exports = { createApp, config };
