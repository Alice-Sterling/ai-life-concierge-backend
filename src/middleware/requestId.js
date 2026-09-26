/**
 * Request ID middleware.
 *
 * Assigns every inbound request an id and attaches a logger already bound to it,
 * so a single WhatsApp message can be followed from the Twilio webhook, through
 * the Anthropic call, into the Airtable sync and out to the error response.
 *
 * Mount this first. Anything above it logs without an id.
 */

const crypto = require('crypto');
const { createLogger } = require('../lib/logger');

// Honour an upstream id when one is present so traces span services, but only
// if it looks like an id. The value lands in log files, and an unbounded header
// is an easy way to inject newlines into them.
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function requestId() {
  return (req, res, next) => {
    const inbound = req.get('x-request-id') || req.get('x-correlation-id');
    req.requestId = SAFE_ID.test(inbound || '') ? inbound : crypto.randomUUID();

    // Echo it back so the caller can quote it in a bug report.
    res.setHeader('x-request-id', req.requestId);

    req.log = createLogger({
      request_id: req.requestId,
      route: `${req.method} ${req.path}`,
    });

    const startedAt = Date.now();
    res.on('finish', () => {
      // 5xx is our fault and deserves attention; everything else is traffic.
      const level = res.statusCode >= 500 ? 'error' : 'info';
      req.log[level]('http.request', {
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        user_id: req.userId || null,
      });
    });

    next();
  };
}

module.exports = { requestId };
