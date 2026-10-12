/**
 * Central configuration and environment validation.
 *
 * Every process.env read in the application happens here, once, at boot. The rest
 * of the codebase imports `config` and never touches process.env directly, so the
 * full set of inputs is visible in one file and a typo fails loudly at startup
 * rather than silently at 3am.
 *
 * Missing values do not crash the process. The prototype is deployed with partial
 * configuration on purpose — a missing Tavily key should degrade search, not take
 * WhatsApp down. `validate()` reports what is missing so /health/integrations can
 * surface it, and only genuinely fatal gaps (no database) stop the boot.
 */

require('dotenv').config();

const str = (key, fallback = null) => {
  const raw = process.env[key];
  if (raw == null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
};

const int = (key, fallback) => {
  const raw = str(key);
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (key, fallback = false) => {
  const raw = str(key);
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const nodeEnv = str('NODE_ENV', 'development');

const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  port: int('PORT', 8080),
  publicBaseUrl: str('PUBLIC_BASE_URL'),

  database: {
    url: str('DATABASE_URL'),
    // Railway's managed Postgres presents a self-signed certificate. Local
    // Postgres generally has no TLS at all, hence the scheme check.
    ssl: str('DATABASE_URL', '').startsWith('postgres://') ? { rejectUnauthorized: false } : false,
  },

  anthropic: { apiKey: str('ANTHROPIC_API_KEY') },
  gemini: { apiKey: str('GEMINI_API_KEY') },
  tavily: { apiKey: str('TAVILY_API_KEY') },
  composio: {
    apiKey: str('COMPOSIO_API_KEY'),
    environment: str('PIPEDREAM_CONNECT_ENV') || str('PIPEDREAM_ENVIRONMENT'),
  },

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
    whatsappFrom: str('TWILIO_WHATSAPP_FROM'),
  },

  stripe: {
    secretKey: str('STRIPE_SECRET_KEY'),
    webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
  },

  airtable: {
    apiKey: str('AIRTABLE_API_KEY'),
    baseId: str('AIRTABLE_BASE_ID'),
    // AIRTABLE_TABLE_NAME wins over AIRTABLE_USER_TABLE_ID, matching the
    // precedence the prototype already used.
    userTableRef: str('AIRTABLE_TABLE_NAME') || str('AIRTABLE_USER_TABLE_ID'),
    tasksTableRef: str('AIRTABLE_TASKS_TABLE_NAME') || str('AIRTABLE_TASKS_TABLE_ID'),
    phoneField: str('AIRTABLE_PHONE_FIELD', 'phone_number'),
    // Field on the Tasks table that links back to the user's profile record.
    tasksUserLinkField: str('AIRTABLE_TASKS_USER_LINK_FIELD', 'User'),
  },

  email: {
    // The prototype uses nodemailer over SMTP. SENDGRID_API_KEY is read because
    // the brief asks for a SendGrid health check, but no SendGrid client exists
    // yet — see README "Schema deviations".
    sendgridApiKey: str('SENDGRID_API_KEY'),
    host: str('EMAIL_HOST'),
    port: int('EMAIL_PORT', 587),
    secure: bool('EMAIL_SECURE', false),
    user: str('EMAIL_USER'),
    pass: str('EMAIL_PASS'),
    from: str('EMAIL_FROM'),
    config: str('EMAIL_CONFIG'),
  },

  pipedream: {
    calendarUrl: str('PIPEDREAM_CALENDAR_URL'),
    calendarToken: str('PIPEDREAM_CALENDAR_TOKEN'),
    calendarQueryWebhook: str('PIPEDREAM_CALENDAR_QUERY_WEBHOOK'),
    executeCalendarTaskUrl: str('EXECUTE_PIPEDREAM_CALENDAR_TASK_URL'),
    architectureProfileToken: str('PIPEDREAM_ARCHITECTURE_PROFILE_TOKEN'),
    fetchArchitectureProfileUrl: str('FETCH_ARCHITECTURE_PROFILE_URL'),
    fetchArchitectureProfileToken: str('FETCH_ARCHITECTURE_PROFILE_TOKEN'),
  },

  // Key for credentials held at rest, e.g. calendar OAuth tokens.
  // 32 bytes of hex. Generate with: openssl rand -hex 32
  encryption: { tokenKey: str('TOKEN_ENCRYPTION_KEY') },

  admin: {
    // Guards the /admin/* endpoints. No fallback value on purpose: an admin API
    // with a default token is an admin API with no token.
    apiToken: str('ADMIN_API_TOKEN'),
  },

  cron: { nudgeSchedule: str('NUDGE_CRON_SCHEDULE') },

  // The front door: status routing before Alice runs. Off by default so the
  // code can ship before the templates are approved and the test accounts
  // are moved to Active. Turning it on is a variable change, not a deploy.
  gate: {
    enabled: bool('STATUS_GATE_ENABLED', false),
    // Comma-separated numbers (+447...) that go through the gate even while it
    // is off for everyone else. For live testing before the real switch-on.
    testNumbers: str('STATUS_GATE_TEST_NUMBERS', '')
      .split(',').map((n) => n.replace(/^whatsapp:/i, '').replace(/\s+/g, '')).filter(Boolean),
    waitlistUrl: str('WAITLIST_URL', 'https://ailifeconcierge.co.uk'),
    // The brief says /onboard; the link Alice sends today is /onboarding.
    // Defaults to the one already in use until the client confirms.
    onboardingUrl: str('ONBOARDING_URL', 'https://ailifeconcierge.co.uk/onboarding'),
    paymentUrl: str('PAYMENT_URL'),
    // A user left in human mode this long with no activity goes back to Alice.
    humanModeTimeoutMinutes: int('HUMAN_MODE_TIMEOUT_MINUTES', 120),
  },

  // Twilio Content SIDs (HX...) for the Meta-approved templates. A template
  // with no SID can still be sent as plain text inside the 24-hour window,
  // which covers every reply to an inbound message.
  templates: {
    unrecognized_user: str('TWILIO_TPL_UNRECOGNIZED_USER'),
    status_waitlist: str('TWILIO_TPL_STATUS_WAITLIST'),
    status_denied: str('TWILIO_TPL_STATUS_DENIED'),
    status_approved: str('TWILIO_TPL_STATUS_APPROVED'),
    pending_stripe: str('TWILIO_TPL_PENDING_STRIPE'),
    membership_inactive: str('TWILIO_TPL_MEMBERSHIP_INACTIVE'),
    active_welcome: str('TWILIO_TPL_ACTIVE_WELCOME'),
    onboarding_reminder: str('TWILIO_TPL_ONBOARDING_REMINDER'),
    handshake_ping: str('TWILIO_TPL_HANDSHAKE_PING'),
    datenight_ping: str('TWILIO_TPL_DATENIGHT_PING'),
  },

  // Proactive messages. Each one is off until its template is approved and
  // tested, then turned on with a variable change, not a deploy.
  lifecycle: {
    // Stripe checkout sets status Active and sends the welcome. Off: Stripe
    // keeps today's behaviour (tier only).
    stripeActivates: bool('STRIPE_SETS_ACTIVE', false),
    onboardingReminder: bool('ONBOARDING_REMINDER_ENABLED', false),
    onboardingReminderHours: int('ONBOARDING_REMINDER_HOURS', 24),
    handshakePing: bool('HANDSHAKE_PING_ENABLED', false),
    handshakeHours: int('HANDSHAKE_PING_HOURS', 48),
    proposalNudge: bool('PROPOSAL_NUDGE_ENABLED', false),
    proposalNudgeHours: int('PROPOSAL_NUDGE_HOURS', 4),
    // On: a due date night sends the morning ping. Off: it raises a desk task, as before.
    dateNightPing: bool('DATE_NIGHT_PING_ENABLED', false),
    dateNightPingHour: int('DATE_NIGHT_PING_HOUR', 9),
    schedule: str('LIFECYCLE_CRON_SCHEDULE', '*/15 * * * *'),
  },

  security: {
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMax: int('RATE_LIMIT_MAX', 120),
    // Twilio signs every webhook. Verification is mandatory in production and
    // optional locally, where requests come from a test script with no signature.
    verifyTwilioSignature: bool('VERIFY_TWILIO_SIGNATURE', nodeEnv === 'production'),
    verifyStripeSignature: bool('VERIFY_STRIPE_SIGNATURE', nodeEnv === 'production'),
  },
};

/** Configuration the process genuinely cannot run without. */
const REQUIRED = [['DATABASE_URL', config.database.url]];

/** Configuration whose absence disables a feature but not the service. */
const RECOMMENDED = [
  ['ANTHROPIC_API_KEY', config.anthropic.apiKey],
  ['TWILIO_ACCOUNT_SID', config.twilio.accountSid],
  ['TWILIO_AUTH_TOKEN', config.twilio.authToken],
  ['TWILIO_WHATSAPP_FROM', config.twilio.whatsappFrom],
  ['STRIPE_SECRET_KEY', config.stripe.secretKey],
  ['STRIPE_WEBHOOK_SECRET', config.stripe.webhookSecret],
  ['AIRTABLE_API_KEY', config.airtable.apiKey],
  ['ADMIN_API_TOKEN', config.admin.apiToken],
];

/**
 * @returns {{ missingRequired: string[], missingRecommended: string[] }}
 */
function validate() {
  return {
    missingRequired: REQUIRED.filter(([, v]) => !v).map(([k]) => k),
    missingRecommended: RECOMMENDED.filter(([, v]) => !v).map(([k]) => k),
  };
}

module.exports = { config, validate };
