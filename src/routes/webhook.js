/**
 * Twilio WhatsApp webhook.
 *
 * The flow, in order:
 *   1. verify the Twilio signature
 *   2. identify or create the user
 *   3. if conversation_mode is 'human', queue the message and stay silent
 *   4. otherwise run the handshake / upgrade / agent branches as before
 *
 * Step 3 is new, and is the point of the human-in-the-loop work: while a user is
 * flagged for human review the agent must not reply over the top of an operator.
 *
 * The agent internals still live in src/legacy/concierge.js, moved verbatim from
 * index.js. This router owns the flow; that module owns the thinking.
 */

const express = require('express');
const { config } = require('../config');
const twilioIntegration = require('../integrations/twilio');
const events = require('../services/events');
const tasks = require('../services/tasks');
const conversations = require('../services/conversations');
const legacy = require('../legacy/concierge');

const router = express.Router();

const OPERATOR_EMAIL = 'assist@ailifeconcierge.co.uk';

/** Reply sent while a user is in human mode, so they are not left in silence. */
const HUMAN_MODE_ACK =
  'Thank you. Your request is with your concierge and someone will be in touch shortly.';

router.post('/webhook', async (req, res) => {
  const log = req.log;
  const phoneNumber = req.body.From;
  const profileName = req.body.ProfileName || req.body.profileName || null;
  const incomingText = String(req.body.Body || '').trim();

  // --- 1. Signature --------------------------------------------------------
  if (config.security.verifyTwilioSignature) {
    if (!twilioIntegration.validateSignature(req)) {
      log.warn('webhook.invalid_signature', { integration: 'twilio', from: phoneNumber });
      return res.status(403).send('Invalid signature');
    }
  } else if (config.isProduction) {
    // Belt and braces: the config default already enables verification in
    // production, but an explicit VERIFY_TWILIO_SIGNATURE=false there is almost
    // certainly a mistake and should be loud.
    log.error('webhook.signature_check_disabled_in_production', { integration: 'twilio' });
  }

  try {
    // --- 2. Identify -------------------------------------------------------
    let user = await legacy.getUserByPhone(phoneNumber);
    const isNewUser = !user;

    if (!user) {
      user = await legacy.createNewUser(phoneNumber, profileName);
      await events.record(events.EVENT.WHATSAPP_STARTED, {
        userId: user.id, requestId: req.requestId, metadata: { profile_name: profileName },
      }, log);
    } else if (!user.first_name && profileName) {
      await legacy.pool.query('UPDATE users SET first_name = $1 WHERE id = $2', [profileName, user.id]);
      user.first_name = profileName;
    }

    req.userId = user.id;
    const userLog = log.child({ user_id: user.id });

    if (!user.client_id) {
      const cid = await legacy.ensureClientIdForUser(user.id);
      if (cid) user.client_id = cid;
    }
    if (!user.short_id) {
      const sid = await legacy.ensureShortIdForUser(user.id);
      if (sid) user.short_id = sid;
    }
    if (!user.phone_number && phoneNumber) user.phone_number = phoneNumber;

    userLog.info('webhook.message_received', {
      is_new_user: isNewUser,
      membership: legacy.getUserMembershipLabel(user),
      body_length: incomingText.length,
    });

    // --- 3. Human hand-off gate -------------------------------------------
    // Checked before any agent work so an operator's conversation is never
    // interrupted, and before the Airtable round-trips so a queued message is
    // cheap.
    if (user.conversation_mode === 'human') {
      await conversations.save(user.id, incomingText, null, { queued_for_human: true }, userLog);

      await tasks.create({
        userId: user.id,
        sourceMessage: incomingText,
        aiSummary: 'Queued while the user is in human conversation mode.',
        category: 'general',
        requiresHuman: true,
        assignedTo: OPERATOR_EMAIL,
        requestId: req.requestId,
      }, userLog);

      userLog.info('webhook.queued_for_human', {});
      res.type('text/xml');
      return res.send(legacy.twimlMessage(HUMAN_MODE_ACK));
    }

    // --- 4. Legacy enrichment ---------------------------------------------
    await legacy.seedAirtableLeadRecord(user, phoneNumber);
    await legacy.refreshAirtableProfileForUser(user);
    await legacy.reconcileUserMembershipTier(user);
    const refreshedProfile = await legacy.getUserByPhone(phoneNumber);
    if (refreshedProfile) user = refreshedProfile;

    if (/\b(reset|start over).*(onboarding|flow)\b/i.test(incomingText)) {
      await legacy.resetOnboardingState(user.id);
      const refreshed = await legacy.getUserByPhone(phoneNumber);
      if (refreshed) user = refreshed;
    }

    // --- Systems-sync handshake -------------------------------------------
    if (incomingText === legacy.SYSTEMS_SYNC_HANDSHAKE_PHRASE) {
      const logId = await events.logAutomation('systems_sync_handshake', 'pending',
        { userId: user.id, requestId: req.requestId }, userLog);
      try {
        const onboardingId = user.short_id || user.client_id;
        if (onboardingId) {
          const airtableSync = await legacy.syncCalendarFromAirtableForUser(user.id, onboardingId);
          await legacy.syncUserTrialStatus(user.id, onboardingId);

          const raw = await legacy.fetchArchitectureProfile(onboardingId);
          const persisted = await legacy.persistArchitectureSessionFromPipedreamResponse(user.id, raw, {
            preserveAutomations: legacy.isOnboardingPending(user),
          });

          if (!airtableSync?.calendarProvider && persisted?.calendarProvider) {
            await legacy.pool.query(
              'UPDATE users SET calendar_provider = $1, architecture_synced_at = NOW() WHERE id = $2',
              [persisted.calendarProvider, user.id]);
          }
          if (persisted?.activeAutomations != null && !legacy.isOnboardingPending(user)) {
            user.active_automations = persisted.activeAutomations;
          }

          await legacy.pool.query(
            'UPDATE users SET onboarding_step = GREATEST(COALESCE(onboarding_step, 1), 6) WHERE id = $1',
            [user.id]);
          await legacy.seedAirtableLeadRecord(user, phoneNumber);

          const refreshed = await legacy.getUserByPhone(phoneNumber);
          if (refreshed) user = refreshed;
          await events.completeAutomation(logId, 'success', null, userLog);
        } else {
          await events.completeAutomation(logId, 'failed', 'missing short_id and client_id', userLog);
        }
      } catch (err) {
        await events.completeAutomation(logId, 'failed', err.message, userLog);
        throw err;
      }
    }

    // --- Handshake verification (skips the agent entirely) -----------------
    if (incomingText === legacy.HANDSHAKE_VERIFICATION_INCOMING_MESSAGE) {
      const shortId = await legacy.ensureShortIdForUser(user.id);
      if (shortId) {
        user.short_id = shortId;
        await legacy.syncCalendarFromAirtableForUser(user.id, shortId);
        await legacy.syncUserTrialStatus(user.id, shortId);
        await legacy.seedAirtableLeadRecord(user, phoneNumber);
        const refreshed = await legacy.getUserByPhone(phoneNumber);
        if (refreshed) user = refreshed;
      } else {
        userLog.error('webhook.short_id_assignment_failed', {});
      }

      await conversations.save(user.id, incomingText,
        legacy.HANDSHAKE_VERIFIED_ALICE_RESPONSE, { trigger: 'handshake_verification' }, userLog);

      res.type('text/xml');
      return res.send(legacy.twimlMessage(legacy.HANDSHAKE_VERIFIED_ALICE_RESPONSE));
    }

    // --- Trial request -----------------------------------------------------
    if (/\b(yes|trial)\b/i.test(incomingText)) {
      const upgradeResponse =
        'Understood. I am notifying the Human Architect to authenticate your Pro Concierge trial '
        + 'and begin your calendar integration. Would you please provide your email address? '
        + 'We will be in touch shortly to finalize the secure link.';

      // A trial request is a hand-off the brief wants tracked, not just emailed.
      // The task is the durable record; the email stays as the notification.
      await tasks.create({
        userId: user.id,
        sourceMessage: incomingText,
        aiSummary: `Trial requested by ${phoneNumber}.`,
        category: 'general',
        priority: 'high',
        requiresHuman: true,
        assignedTo: OPERATOR_EMAIL,
        requestId: req.requestId,
      }, userLog);

      await legacy.sendEmail({
        to: OPERATOR_EMAIL,
        subject: `TRIAL REQUESTED: ${phoneNumber}`,
        text: `Trial requested.\n\nFrom: ${phoneNumber}\nProfileName: ${profileName || ''}\n`
          + `ClientID: ${user.client_id || ''}\nMessage: ${incomingText}\nTier: ${user.tier}\n`
          + `Request ID: ${req.requestId}\nTimestamp: ${new Date().toISOString()}`,
      });

      await conversations.save(user.id, incomingText, upgradeResponse, {}, userLog);
      res.type('text/xml');
      return res.send(legacy.twimlMessage(upgradeResponse));
    }

    // --- Agent -------------------------------------------------------------
    const aiText = await legacy.runAgenticConcierge(user, incomingText, {
      senderPhoneNumber: phoneNumber || user.phone_number,
    });

    const replyBody =
      typeof aiText === 'string' && aiText.trim() !== ''
        ? aiText
        : 'I have received your message. One moment while I prepare a reply.';

    if (legacy.getSubscriptionStatusFromUser(user) === 'PRO') {
      await tasks.create({
        userId: user.id,
        sourceMessage: incomingText,
        aiSummary: replyBody.slice(0, 2000),
        category: 'general',
        priority: 'vip',
        requiresHuman: true,
        assignedTo: OPERATOR_EMAIL,
        requestId: req.requestId,
      }, userLog);

      await legacy.sendEmail({
        to: OPERATOR_EMAIL,
        subject: `PRO TASK: ${phoneNumber}`,
        text: `Pro task received.\n\nFrom: ${phoneNumber}\nClientID: ${user.client_id || ''}\n`
          + `Message: ${incomingText}\n\nAI response:\n${replyBody}\n\n`
          + `Request ID: ${req.requestId}\nTimestamp: ${new Date().toISOString()}`,
      });
    }

    await conversations.save(user.id, incomingText, replyBody, {}, userLog);

    res.type('text/xml');
    return res.send(legacy.twimlMessage(replyBody));
  } catch (err) {
    log.error('webhook.failed', { message: err.message, stack: err.stack });

    // Twilio retries on 5xx, which would replay the whole flow. A 200 with a
    // polite message stops the loop; the failure is in the logs and, for
    // automation runs, in automation_logs.
    res.type('text/xml');
    return res.send(legacy.twimlMessage(
      'Apologies, I hit a problem handling that. Please try again in a moment.'));
  }
});

module.exports = router;
