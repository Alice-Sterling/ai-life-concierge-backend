/**
 * Stripe webhook.
 *
 * Must be mounted ABOVE express.json(): Stripe signs the exact request bytes, so
 * the body has to reach constructEvent() as an unparsed Buffer. Parsing it first
 * re-serialises it and the signature no longer matches.
 */

const express = require('express');
const { config } = require('../config');
const stripeIntegration = require('../integrations/stripe');
const db = require('../db/pool');
const events = require('../services/events');

const router = express.Router();

router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const log = req.log;

  if (!stripeIntegration.isConfigured()) {
    log.warn('stripe.not_configured', { integration: 'stripe' });
    return res.status(503).send('Stripe not configured');
  }

  const signature = req.get('stripe-signature');
  let event;

  try {
    event = stripeIntegration.constructEvent(req.body, signature);
  } catch (err) {
    log.warn('stripe.signature_verification_failed', {
      integration: 'stripe', message: err.message,
    });

    // Verification failure is fatal in production. Locally it is relaxed so the
    // Stripe CLI and hand-made test payloads can drive the handler.
    if (config.security.verifyStripeSignature) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      event = JSON.parse(req.body.toString('utf8'));
      log.warn('stripe.signature_check_skipped', { integration: 'stripe', env: config.env });
    } catch {
      return res.status(400).send('Malformed payload');
    }
  }

  log.info('stripe.event_received', { integration: 'stripe', event_type: event.type });

  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true });
  }

  try {
    const session = event.data.object;
    const phone = session.metadata?.phone || null;
    const email = session.metadata?.email
      || session.customer_email
      || session.customer_details?.email
      || null;

    // Phone is the primary key for a WhatsApp product; email is the fallback
    // for checkouts that never captured one.
    let user = null;
    if (phone) {
      const { rows } = await db.query(
        'SELECT id, phone_number, email FROM users WHERE phone_number = $1', [phone], log);
      user = rows[0] || null;
    }
    if (!user && email) {
      const { rows } = await db.query(
        'SELECT id, phone_number, email FROM users WHERE email = $1', [email], log);
      user = rows[0] || null;
    }

    if (!user) {
      log.warn('stripe.user_not_found', { integration: 'stripe', has_phone: Boolean(phone), has_email: Boolean(email) });
      return res.json({ received: true });
    }

    await db.query(
      'UPDATE users SET tier = $1, subscription_status = $2 WHERE id = $3',
      ['pro', 'PRO', user.id], log);

    log.info('stripe.user_upgraded', { integration: 'stripe', user_id: user.id });
    await events.record(events.EVENT.SUBSCRIPTION_UPGRADED, {
      userId: user.id, requestId: req.requestId, metadata: { tier: 'pro', source: 'stripe' },
    }, log);
  } catch (err) {
    // Return 200 even on failure: Stripe would otherwise retry for days, and a
    // database error will not fix itself on the third attempt. The event is in
    // the log for manual reconciliation.
    log.error('stripe.processing_failed', { integration: 'stripe', message: err.message });
  }

  return res.json({ received: true });
});

module.exports = router;
