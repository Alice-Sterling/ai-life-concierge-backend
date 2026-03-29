require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const Composio = require('@composio/client');
const { GoogleGenAI } = require('@google/genai');
const { tavily } = require('@tavily/core');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('Warning: Stripe key missing. Webhooks will not function.');
}
const tavilyClient = process.env.TAVILY_API_KEY ? tavily({ apiKey: process.env.TAVILY_API_KEY }) : null;
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const app = express();

// Stripe webhook needs raw body for signature verification (must be before express.json())
app.post(
  '/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) {
      res.status(503).send('Stripe not configured');
      return;
    }
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !sig) {
      res.status(400).send('Missing webhook secret or signature');
      return;
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const phone = session.metadata?.phone || null;
      const email = session.metadata?.email || session.customer_email || session.customer_details?.email || null;
      let user = null;
      if (phone) {
        const byPhone = await pool.query('SELECT id, phone_number, email FROM users WHERE phone_number = $1', [phone]);
        user = byPhone.rows[0] || null;
      }
      if (!user && email) {
        const byEmail = await pool.query('SELECT id, phone_number, email FROM users WHERE email = $1', [email]);
        user = byEmail.rows[0] || null;
      }
      if (user) {
        await pool.query('UPDATE users SET tier = $1, subscription_status = $2 WHERE id = $3', [
          'pro',
          'PRO',
          user.id,
        ]);
        const identifier = user.phone_number || user.email || user.id;
        console.log(`User [${identifier}] upgraded to PRO tier.`);
      }
      res.json({ received: true });
      return;
    }
    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.startsWith('postgres://') ? { rejectUnauthorized: false } : false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const composio = process.env.COMPOSIO_API_KEY ? Composio({ apiKey: process.env.COMPOSIO_API_KEY }) : null;
const googleAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

function getMasterSkill() {
  const skillPath = path.join(__dirname, 'skills', 'sovereign_architect.md');
  return fs.readFileSync(skillPath, 'utf8');
}

/** Days since start (trial anchor). Uses absolute calendar diff; invalid/missing dates return null. */
function calculateTrialDay(startDate) {
  if (startDate == null || startDate === '') return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const today = new Date();
  const diffTime = Math.abs(today - start);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/** Ensures vault/Tavily search input is a plain string (avoids Tavily 422 when query was serialized as '{"query":"..."}'). */
function normalizeSearchQueryText(input) {
  if (input == null) return '';
  if (typeof input === 'object' && !Array.isArray(input)) {
    const q = input.query != null ? input.query : input.text;
    if (q != null) return String(q).trim();
    return '';
  }
  const s = String(input).trim();
  if (s.startsWith('{') && s.includes('"query"')) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed.query === 'string') return parsed.query.trim();
    } catch {
      /* ignore */
    }
  }
  return s;
}

/** True when the user message suggests connecting Google / calendar / OAuth (skip Tavily for these). */
function hasHandshakeKeywordIntent(msgText) {
  return /\b(connect|calendar|google|auth|link)\b/i.test(normalizeSearchQueryText(msgText));
}

/** PRO/LITE from Postgres `subscription_status` only (no `tier` fallback). */
function getSubscriptionStatusFromUser(user) {
  if (user?.subscription_status != null && String(user.subscription_status).trim() !== '') {
    const u = String(user.subscription_status).trim().toUpperCase();
    return u === 'PRO' ? 'PRO' : 'LITE';
  }
  return 'LITE';
}

const ELITE_TRIAGE_SYSTEM_PROMPT = `
Role: Lead Triage Architect for Ai Life Concierge (ALC).
Persona: Elite Chief of Staff. Sophisticated, radically proactive, and value-driven.

Standard Opening (Welcome Hook / Menu of Autonomy):
If this is the user's first interaction or they are just saying hello, respond with:
"Architect here. I am currently in Delight-First mode. You can ask me to:

Curate & Verify: Research and provide verified booking/purchasing links for any request.

Logistical Prediction: I can analyze your week to find friction you haven't seen yet.

Autonomous Execution (Pro): I link to your calendar and apps to handle the 'doing' while you simply approve.

I am eager to begin. What is the most time-consuming task on your mind today?"

Operating logic:
- DELIGHT FIRST: Provide a curated recommendation with a verified link. Include a concise WHY and the next best action (booking/calendar link where relevant).
- SOFT NUDGE (Lite Users): Describe Pro Vault benefits: predictive logistics, human-in-the-loop oversight, and ~10 hours recovered weekly.
- CLOSING: "Would you like to activate a 30-day Concierge Pro Trial to automate this entire workflow?"

Agentic Auditing (mandatory):
1. MANDATORY EMAIL RULE: If a user expresses interest in a trial (e.g. says yes, trial, sign up, activate), you MUST NOT proceed with any other task until you have confirmed their email address. If they have not yet provided it, your ONLY response must be a polite request for their email—do not answer other questions or offer links until the email is received.
2. INQUISITIVE DELIGHT: When providing a recommendation, you must also ask one follow-up question that targets "Time Leakage"—e.g. "I've found the booking link for [Restaurant]. Out of curiosity, how many hours a month do you spend managing these types of administrative logistics?"
3. PREDICTIVE STAGING: Always suggest one "Automated Next Step"—e.g. "I have the flight details. In the Pro Vault, I would now cross-reference this with your weather app and stage a car for your arrival. Would you like to see how we automate that?"

Composio execution (when integrations are connected):
- You may execute real actions on the user's linked apps via Composio using the tool named execute_action.
- Call execute_action with: tool_slug (exact Composio tool identifier), arguments (object matching that tool's schema), and connected_account_id when the user has multiple connections for the same toolkit.
- Use execute_action only when it genuinely advances the user's request; otherwise continue with guidance and verified links.

LOCKED OVERRIDE (google_super / Gmail & Calendar):
- If LIVE USER CONTEXT shows google_super under locked_integrations (not ACTIVE), you MUST call initiate_secure_handshake before any execute_action that targets Gmail or Google Calendar tools. Do not attempt Gmail/Calendar execute_action until google_super is ACTIVE.

AUTHENTICATION PRIORITIZATION (read LIVE USER CONTEXT):
- If the user mentions connect, calendar, google, auth, or link (case-insensitive) AND google_super_handshake_required is true:
  - IMMEDIATELY call the initiate_secure_handshake tool (or use the redirectUrl already provided). Do not perform a Tavily search or other web research first.
- When tool_result from initiate_secure_handshake includes redirectUrl, your very next assistant message MUST contain that full https URL verbatim so the user can open it. Never send a generic reply without the link.

Constraint: Elite, professional tone. Economical but powerful language. No emojis.
`;

const NEW_LEAD_ALERT_EMAIL = 'assist@ailifeconcierge.co.uk';
const REQUEST_SUMMARY_EMAIL = 'assist@ailifeconcierge.co.uk';

function formatToolboxSummary(connections, availableTools) {
  const lines = [];
  lines.push(`Active Composio connections (${connections.length}):`);
  connections.forEach((c) => {
    lines.push(`- Toolkit: ${c.toolkitSlug} | connection_id: ${c.id}`);
  });
  lines.push('');
  lines.push('Available tool slugs (use execute_action with exact tool_slug):');
  const preview = availableTools.slice(0, 80);
  preview.forEach((t) => {
    const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`- ${t.slug} (${t.toolkit})${desc ? ` — ${desc}` : ''}`);
  });
  if (availableTools.length > preview.length) {
    lines.push(`... and ${availableTools.length - preview.length} more tools.`);
  }
  return lines.join('\n');
}

/** Composio toolkit slug for unified Google (Gmail + Calendar) — must be ACTIVE before Gmail/Calendar execute_action. */
const GOOGLE_SUPER_TOOLKIT = 'google_super';

const EXECUTE_ACTION_ANTHROPIC_TOOL = {
  name: 'execute_action',
  description:
    'Execute a Composio integration action for this user (email, calendar, CRM, etc.). Requires exact tool_slug and arguments object. Use connected_account_id from the toolbox context when multiple connections exist for one toolkit. Do not use for Gmail/Google Calendar when google_super is LOCKED—use initiate_secure_handshake first.',
  input_schema: {
    type: 'object',
    properties: {
      tool_slug: {
        type: 'string',
        description: 'Exact Composio tool slug (e.g. GMAIL_SEND_EMAIL).',
      },
      arguments: {
        type: 'object',
        description: 'Structured arguments for that tool.',
      },
      connected_account_id: {
        type: 'string',
        description: 'Composio connected account id when disambiguation is needed.',
      },
    },
    required: ['tool_slug', 'arguments'],
  },
};

const INITIATE_SECURE_HANDSHAKE_ANTHROPIC_TOOL = {
  name: 'initiate_secure_handshake',
  description:
    'Start the secure OAuth flow for Google (Gmail + Calendar) via Composio (google_super). Calls Composio connected_accounts/initiate and returns an OAuth URL for the user. Call this BEFORE any Gmail or Google Calendar execute_action when google_super is LOCKED in LIVE USER CONTEXT.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'Brief note on what the user needs after Google is connected (e.g. send email, create calendar event).',
      },
    },
  },
};

function buildConnectionStatusReport(connections) {
  const list = connections || [];
  const active_integrations = list.map((c) => ({
    toolkit: c.toolkitSlug,
    connection_id: c.id,
    state: 'ACTIVE',
  }));
  const activeSlugs = new Set(list.map((c) => c.toolkitSlug).filter((s) => s && s !== 'unknown'));
  const locked_integrations = [];
  if (!activeSlugs.has(GOOGLE_SUPER_TOOLKIT)) {
    locked_integrations.push({ toolkit: GOOGLE_SUPER_TOOLKIT, state: 'LOCKED' });
  }
  return { active_integrations, locked_integrations };
}

async function executeComposioAction(toolInput, composioUserId) {
  if (!composio) {
    return JSON.stringify({ error: 'Composio is not configured' });
  }
  const slug = toolInput?.tool_slug || toolInput?.toolSlug;
  if (!slug) {
    return JSON.stringify({ error: 'Missing tool_slug' });
  }
  try {
    const res = await composio.tools.execute(slug, {
      arguments: typeof toolInput.arguments === 'object' && toolInput.arguments !== null ? toolInput.arguments : {},
      user_id: String(composioUserId),
      ...(toolInput.connected_account_id ? { connected_account_id: toolInput.connected_account_id } : {}),
    });
    return typeof res === 'string' ? res : JSON.stringify(res);
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

/**
 * Resolves Composio `entityId` from a user row or a raw id string (numbers must stay String-wrapped for the API).
 * @param {object|string|number|null|undefined} user - User row `{ id, phone?, phone_number? }` or primitive id
 * @returns {string|null}
 */
function resolveComposioEntityId(user) {
  let entityId;
  if (user != null && typeof user === 'object' && !Array.isArray(user)) {
    entityId = String(user.id || user.phone || user.phone_number).trim();
  } else {
    entityId = String(user ?? '').trim();
  }
  if (!entityId || entityId === 'undefined' || entityId === 'null') {
    console.error('[ERROR] No valid Entity ID found for handshake');
    return null;
  }
  return entityId;
}

/**
 * POST /v1/connected_accounts/initiate — entityId must match Composio `user_id` elsewhere; always stringified.
 */
async function initiateClientConnection(userOrEntityId) {
  const entityId = resolveComposioEntityId(userOrEntityId);
  if (entityId == null) {
    return null;
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  const authConfigId =
    process.env.COMPOSIO_AUTH_CONFIG_ID != null && String(process.env.COMPOSIO_AUTH_CONFIG_ID).trim() !== ''
      ? String(process.env.COMPOSIO_AUTH_CONFIG_ID).trim()
      : '';
  const redirectUrl = process.env.COMPOSIO_REDIRECT_URL || 'https://ailifeconcierge.co.uk/vault-confirmed';

  if (!apiKey) {
    console.error('[AUTH] COMPOSIO_API_KEY is not set');
    return null;
  }
  if (!authConfigId) {
    console.error('[AUTH] COMPOSIO_AUTH_CONFIG_ID is not set or empty');
    return null;
  }

  try {
    console.log('[AUTH] Attempting handshake for Entity: ' + entityId);
    console.log('[DEBUG] Handshake Payload:', { entityId, authConfigId });

    const response = await axios.post(
      'https://api.composio.dev/v1/connected_accounts/initiate',
      {
        entityId: String(entityId),
        authConfigId,
        redirectUrl,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('[CRITICAL] Composio API Response:', JSON.stringify(response.data));

    const finalUrl = response.data.redirectUrl || response.data.data?.redirectUrl;

    if (!finalUrl) {
      console.error('[AUTH] Composio Response missing URL:', JSON.stringify(response.data));
      return null;
    }

    console.log(`[AUTH] Success! Link generated for ${entityId}`);
    return finalUrl;
  } catch (error) {
    console.error('[AUTH] CRITICAL FAILURE:', error.response?.data || error.message);
    return null;
  }
}

/** Wraps initiateClientConnection for the Anthropic tool (JSON string for tool_result). */
async function buildHandshakeToolResult(entityId, intent) {
  const finalUrl = await initiateClientConnection({ id: entityId });
  if (!finalUrl) {
    return JSON.stringify({
      status: 'error',
      toolkit: GOOGLE_SUPER_TOOLKIT,
      intent: intent || null,
      message: 'Could not obtain OAuth URL. Check Railway logs for [AUTH] lines.',
    });
  }
  return JSON.stringify({
    status: 'handshake_initiated',
    toolkit: GOOGLE_SUPER_TOOLKIT,
    intent: intent || null,
    redirectUrl: finalUrl,
    instruction:
      'Give the user this OAuth URL to open in a browser to connect Google. After they complete OAuth and land on vault-confirmed, google_super should become ACTIVE.',
  });
}

/**
 * Fetches active Composio connections for the user and builds a Toolbox (metadata + Anthropic tool defs).
 * @param {string} userId - Postgres user UUID; used as Composio entityId / user_id everywhere.
 * @param {{ subscriptionStatus?: 'PRO'|'LITE' }} [options] - execute_action is only exposed when subscriptionStatus is PRO.
 */
async function getAgentTools(userId, options = {}) {
  const uid = String(userId);
  const subscriptionStatus = options.subscriptionStatus === 'PRO' ? 'PRO' : 'LITE';
  if (!composio) {
    return {
      connections: [],
      availableTools: [],
      anthropicTools: [],
      toolboxSummary: '',
    };
  }
  try {
    const list = await composio.connectedAccounts.list({
      user_ids: [uid],
      statuses: ['ACTIVE'],
      limit: 100,
    });
    const items = list.items || [];
    const connections = items.map((item) => ({
      id: item.id,
      toolkitSlug: item.toolkit?.slug || 'unknown',
    }));
    const toolkitSlugs = [...new Set(connections.map((c) => c.toolkitSlug).filter((s) => s && s !== 'unknown'))];
    const availableTools = [];
    const seenSlugs = new Set();
    for (const slug of toolkitSlugs) {
      const toolsResp = await composio.tools.list({ toolkit_slug: slug, limit: 100 });
      const conn = connections.find((c) => c.toolkitSlug === slug);
      for (const t of toolsResp.items || []) {
        if (seenSlugs.has(t.slug)) continue;
        seenSlugs.add(t.slug);
        availableTools.push({
          slug: t.slug,
          name: t.name,
          description: t.description || t.human_description || '',
          toolkit: slug,
          connectedAccountId: conn?.id,
        });
      }
    }
    const toolboxSummary = connections.length > 0 ? formatToolboxSummary(connections, availableTools) : '';
    const googleSuperActive = connections.some((c) => c.toolkitSlug === GOOGLE_SUPER_TOOLKIT);
    // google_super_handshake_required: handshake tool first so tool_choice can target it before execute_action
    const anthropicTools = [];
    if (!googleSuperActive) {
      anthropicTools.push(INITIATE_SECURE_HANDSHAKE_ANTHROPIC_TOOL);
    }
    if (connections.length > 0 && subscriptionStatus === 'PRO') {
      anthropicTools.push(EXECUTE_ACTION_ANTHROPIC_TOOL);
    }
    return {
      connections,
      availableTools,
      anthropicTools,
      toolboxSummary,
    };
  } catch (err) {
    console.error('getAgentTools error:', err.message);
    return {
      connections: [],
      availableTools: [],
      anthropicTools: [INITIATE_SECURE_HANDSHAKE_ANTHROPIC_TOOL],
      toolboxSummary: '',
      error: err.message,
    };
  }
}

function generateClientId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `Ai-${suffix}`;
}

async function ensureClientIdForUser(userId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateClientId();
    try {
      const updated = await pool.query(
        `UPDATE users
         SET client_id = $1
         WHERE id = $2 AND (client_id IS NULL OR client_id = '')
         RETURNING id, client_id`,
        [candidate, userId]
      );
      if (updated.rowCount > 0) return candidate;
      const existing = await pool.query('SELECT client_id FROM users WHERE id = $1', [userId]);
      return existing.rows[0]?.client_id || null;
    } catch (err) {
      // Likely unique violation; retry with a new ID
    }
  }
  return null;
}

/** Table name (e.g. Users) or table id (tbl…); AIRTABLE_TABLE_NAME takes precedence over AIRTABLE_USER_TABLE_ID. */
function getAirtableTableRef() {
  const byName = process.env.AIRTABLE_TABLE_NAME;
  if (byName != null && String(byName).trim() !== '') return String(byName).trim();
  const byId = process.env.AIRTABLE_USER_TABLE_ID;
  if (byId != null && String(byId).trim() !== '') return String(byId).trim();
  return null;
}

/** Airtable field names — set AIRTABLE_*_FIELD in Railway to match your base exactly. */
function buildAirtableRecordFields({ client_id, phone_number, email, tier, last_message }) {
  const pick = (envKey, fallback) => {
    const v = process.env[envKey];
    if (v != null && String(v).trim() !== '') return String(v).trim();
    return fallback;
  };
  const phoneColumn = pick('AIRTABLE_PHONE_FIELD', 'Phone Number');
  const emailField = pick('AIRTABLE_EMAIL_FIELD', 'Email');
  const tierField = pick('AIRTABLE_TIER_FIELD', 'Tier');
  const lastMsgField = pick('AIRTABLE_LAST_MESSAGE_FIELD', 'Last Message');

  return {
    'Client ID': client_id ?? '',
    [phoneColumn]: phone_number ?? '',
    [emailField]: email ?? '',
    [tierField]: tier ?? '',
    [lastMsgField]: last_message ?? '',
  };
}

async function syncToAirtable({ client_id, phone_number, email, tier, last_message }) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID != null ? String(process.env.AIRTABLE_BASE_ID).trim() : '';
  const tableRef = getAirtableTableRef();

  if (!apiKey || !baseId || !tableRef) {
    return;
  }

  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableRef)}`;
  const keyHint =
    apiKey.length > 12 ? `Bearer ****…${apiKey.slice(-4)}` : 'Bearer ****';

  const fields = buildAirtableRecordFields({ client_id, phone_number, email, tier, last_message });
  const payload = {
    records: [
      {
        fields,
      },
    ],
  };

  try {
    console.log(`[AIRTABLE] POST ${url} (${keyHint})`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.log('[AIRTABLE] Sync failed but continuing to Agent...');
      if (resp.status === 404) {
        console.warn(
          '[AIRTABLE] Resource not found. Check BASE_ID and TABLE_NAME in Railway.',
          `(POST ${url})`
        );
      } else {
        console.warn('[AIRTABLE] HTTP', resp.status, text.slice(0, 500));
      }
    }
  } catch (err) {
    console.log('[AIRTABLE] Sync failed but continuing to Agent...');
    console.warn('[AIRTABLE] non-critical sync error:', err?.message || err);
  }
}

// 24-hour automation nudge: hourly check for lite users whose last message was 20–23h ago
const SOVEREIGN_NUDGE_MESSAGE = `Architect here. I've been monitoring your request. I have a predictive strategy ready that would offload these logistics entirely. Would you like to activate a 30-day free trial of the Pro Vault to see the difference? Reply 'YES' to begin.`;

cron.schedule(process.env.NUDGE_CRON_SCHEDULE || '0 * * * *', async () => {
  if (!twilioClient || !process.env.TWILIO_WHATSAPP_FROM) {
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.phone_number, u.first_name
       FROM users u
       INNER JOIN (
         SELECT user_id, MAX(timestamp) AS last_ts
         FROM conversations
         GROUP BY user_id
       ) last ON last.user_id = u.id
       WHERE u.tier = 'lite'
         AND u.last_nudge_at IS NULL
         AND last.last_ts >= NOW() - INTERVAL '23 hours'
         AND last.last_ts <= NOW() - INTERVAL '20 hours'`
    );
    for (const user of rows) {
      const to = user.phone_number.startsWith('whatsapp:') ? user.phone_number : `whatsapp:${user.phone_number}`;
      await twilioClient.messages.create({
        body: SOVEREIGN_NUDGE_MESSAGE,
        from: process.env.TWILIO_WHATSAPP_FROM,
        to,
      });
      await pool.query('UPDATE users SET last_nudge_at = NOW() WHERE id = $1', [user.id]);
      console.log('Nudge sent to', user.phone_number);
    }
  } catch (err) {
    console.error('Nudge cron failed:', err.message);
  }
});

async function runInitScript() {
  const client = await pool.connect();
  try {
    const initPath = path.join(__dirname, 'init-db.sql');
    const sql = fs.readFileSync(initPath, 'utf8');
    await client.query(sql);
    console.log('Database initialization script executed successfully.');
  } catch (err) {
    console.error('Error running database initialization script:', err);
  } finally {
    client.release();
  }
}

function getEmailTransporter() {
  let config = {};
  try {
    if (process.env.EMAIL_CONFIG) {
      config = typeof process.env.EMAIL_CONFIG === 'string' ? JSON.parse(process.env.EMAIL_CONFIG) : process.env.EMAIL_CONFIG;
    } else {
      config = {
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT || '587', 10),
        secure: process.env.EMAIL_SECURE === 'true',
        auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined,
      };
    }
  } catch (e) {
    console.error('Email config parse error:', e.message);
  }
  return nodemailer.createTransport(config);
}

async function sendEmail({ to, subject, text }) {
  const transporter = getEmailTransporter();
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@ailifeconcierge.co.uk',
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

async function syncTrialStartDateIfNull(user) {
  if (!user || user.trial_start_date != null) return user;
  const r = await pool.query(
    `UPDATE users SET trial_start_date = created_at WHERE id = $1 AND trial_start_date IS NULL RETURNING trial_start_date`,
    [user.id]
  );
  if (r.rows[0]) user.trial_start_date = r.rows[0].trial_start_date;
  return user;
}

async function getUserByPhone(phoneNumber) {
  const result = await pool.query(
    'SELECT id, first_name, last_name, phone_number, email, client_id, tier, last_nudge_at, created_at, trial_start_date, subscription_status FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  const row = result.rows[0] || null;
  if (row) await syncTrialStartDateIfNull(row);
  return row;
}

async function createNewUser(phoneNumber, profileName) {
  const result = await pool.query(
    `INSERT INTO users (phone_number, first_name, tier, client_id)
     VALUES ($1, $2, 'lite', $3)
     RETURNING id, first_name, last_name, phone_number, email, client_id, tier, last_nudge_at, created_at, trial_start_date, subscription_status`,
    [phoneNumber, profileName || 'Explorer', generateClientId()]
  );
  const row = result.rows[0];
  await syncTrialStartDateIfNull(row);
  return row;
}

async function saveConversation(userId, messageBody, aiResponse, metadata = {}) {
  await pool.query(
    `INSERT INTO conversations (user_id, message_body, ai_response, metadata) VALUES ($1, $2, $3, $4)`,
    [userId, messageBody, aiResponse, JSON.stringify(metadata)]
  );
}

async function getChatHistory(userId) {
  const result = await pool.query(
    'SELECT message_body, ai_response FROM conversations WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10',
    [userId]
  );

  const history = [];
  result.rows.reverse().forEach((row) => {
    if (row?.message_body) {
      history.push({ role: 'user', content: row.message_body });
    }
    if (row?.ai_response) {
      history.push({ role: 'assistant', content: row.ai_response });
    }
  });
  return history;
}

function extractRedirectUrlFromToolConversation(conv) {
  for (let i = conv.length - 1; i >= 0; i -= 1) {
    const m = conv[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      try {
        const d = JSON.parse(block.content);
        if (d.redirectUrl && typeof d.redirectUrl === 'string') return d.redirectUrl;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function getHybridResponseFromMessages(
  messages,
  userMessage,
  toolbox,
  composioUserId,
  baseSystemPrompt = null,
  options = {}
) {
  const composioSupplement =
    toolbox?.toolboxSummary && String(toolbox.toolboxSummary).trim()
      ? `\n\n[Composio toolbox for this user]\n${toolbox.toolboxSummary}`
      : '';
  const system = (baseSystemPrompt || ELITE_TRIAGE_SYSTEM_PROMPT) + composioSupplement;
  const hasComposioTools = Boolean(toolbox?.anthropicTools?.length);

  // --- TRY CLAUDE FIRST ---
  try {
    if (hasComposioTools) {
      const conv = messages.map((m) => ({ role: m.role, content: m.content }));
      for (let step = 0; step < 6; step += 1) {
        const createPayload = {
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          system,
          tools: toolbox.anthropicTools,
          messages: conv,
        };
        if (
          options.forceHandshakeToolFirst &&
          step === 0 &&
          toolbox.anthropicTools?.some((t) => t.name === 'initiate_secure_handshake')
        ) {
          createPayload.tool_choice = { type: 'tool', name: 'initiate_secure_handshake' };
        }
        const msg = await anthropic.messages.create(createPayload);
        const blocks = msg.content || [];
        const toolUses = blocks.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) {
          const tb = blocks.find((b) => b.type === 'text');
          let text = tb ? tb.text : '';
          const mandatoryUrl = extractRedirectUrlFromToolConversation(conv);
          if (mandatoryUrl && text && !text.includes(mandatoryUrl)) {
            text = `${text.trim()}\n\nSecure link to connect Google: ${mandatoryUrl}`;
          }
          return text;
        }
        conv.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const tu of toolUses) {
          if (tu.name === 'execute_action') {
            const payload = await executeComposioAction(tu.input, composioUserId);
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: payload,
            });
          } else if (tu.name === 'initiate_secure_handshake') {
            const payload = await buildHandshakeToolResult(composioUserId, tu.input?.intent);
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: payload,
            });
          } else {
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ error: `Unknown tool: ${tu.name}` }),
            });
          }
        }
        conv.push({ role: 'user', content: results });
      }
      return 'I reached the maximum number of tool steps. A human architect can assist.';
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages,
    });
    const firstText = msg.content?.find((b) => b.type === 'text');
    return firstText ? firstText.text : '';
  } catch (claudeErr) {
    console.error('Claude Failed. Error:', claudeErr.message);

    // --- FAIL-SAFE: GEMINI ---
    try {
      const geminiModel = googleAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const geminiHistory = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        }));

      const chat = geminiModel.startChat({
        history: geminiHistory.slice(0, -1),
        systemInstruction: system,
      });

      const result = await chat.sendMessage(userMessage);
      return result.response.text();
    } catch (geminiErr) {
      console.error('Total Outage:', geminiErr.message);
      return 'I have received your request, but my neural link is currently calibrating. A human architect will assist you shortly.';
    }
  }
}

async function searchRecommendations(query) {
  const raw = normalizeSearchQueryText(query);
  const q = `%${raw}%`;

  const stop = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'me', 'my',
    'of', 'on', 'or', 'our', 'please', 'the', 'their', 'to', 'us', 'we', 'with', 'you', 'your',
  ]);

  // Lightweight keyword extraction for vibe_tags matching.
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 3 && !stop.has(t));

  const vibeTags = Array.from(new Set(tokens)).slice(0, 12);

  // Weights are ordered as {D, C, B, A} in Postgres.
  // Required: A=1.0 (name), B=0.4 (category/location), C=0.1 (description)
  const weights = [0.0, 0.1, 0.4, 1.0];

  const { rows } = await pool.query(
    `
    WITH ranked AS (
      SELECT
        r.*,
        ts_rank_cd(
          $3::real[],
          (
            setweight(to_tsvector('english', r.name), 'A') ||
            setweight(to_tsvector('english', coalesce(r.category, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(r.location, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(r.description, '')), 'C')
          ),
          plainto_tsquery('english', $1)
        ) AS db_rank,
        COALESCE((
          SELECT COUNT(*)
          FROM unnest(COALESCE(r.vibe_tags, ARRAY[]::text[])) AS vt(tag)
          WHERE vt.tag = ANY($2::text[])
        ), 0) AS tag_score
      FROM recommendations r
      WHERE
        (
          (
            setweight(to_tsvector('english', r.name), 'A') ||
            setweight(to_tsvector('english', coalesce(r.category, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(r.location, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(r.description, '')), 'C')
          ) @@ plainto_tsquery('english', $1)
        )
        OR (COALESCE(r.vibe_tags, ARRAY[]::text[]) && $2::text[])
        OR r.name ILIKE $4
        OR r.category ILIKE $4
        OR r.location ILIKE $4
        OR r.description ILIKE $4
    )
    SELECT
      id, name, category, location, booking_url, description, vibe_tags,
      db_rank,
      tag_score,
      (db_rank + (tag_score * 0.05)) AS final_rank
    FROM ranked
    ORDER BY final_rank DESC, id DESC
    LIMIT 5
    `,
    [raw, vibeTags, weights, q]
  );

  const best = rows?.[0]?.final_rank ?? 0;
  const lowConfidence = best < 0.1;
  return { rows, lowConfidence, bestRank: best };
}

// Tool: search Postgres vault first, live web second (Tavily optional via skipTavily).
async function search_vault_and_web(query, { skipTavily = false } = {}) {
  const qText = String(normalizeSearchQueryText(query) ?? '').trim();
  const vaultResult = await searchRecommendations(qText);
  const vault = vaultResult.rows;
  let web = [];

  if (!skipTavily && tavilyClient && qText.length > 0) {
    try {
      const tavilyQuery = String(qText);
      const result = await tavilyClient.search({
        query: tavilyQuery,
        max_results: 5,
        include_answer: false,
        include_images: false,
      });
      web = Array.isArray(result?.results) ? result.results : [];
    } catch (err) {
      console.error('[Tavily] search failed (non-fatal):', err?.message || err);
      web = [];
    }
  }

  return { vault, web, vaultLowConfidence: vaultResult.lowConfidence, vaultBestRank: vaultResult.bestRank };
}

async function runAgenticConcierge(user, userMessage) {
  const msgText = String(normalizeSearchQueryText(userMessage) ?? '').trim();
  const subscriptionStatus = getSubscriptionStatusFromUser(user);
  const toolbox = await getAgentTools(user.id, { subscriptionStatus });
  const googleSuperActive = (toolbox.connections || []).some((c) => c.toolkitSlug === GOOGLE_SUPER_TOOLKIT);

  // Hard-anchor: calendar/connect + vault not linked — OAuth only, no Claude (avoids webhook timeout)
  if (/\b(calendar|connect)\b/i.test(msgText) && process.env.COMPOSIO_API_KEY && !googleSuperActive) {
    const link = await initiateClientConnection(user);
    if (link) {
      return `Handshake Initiated. Secure link: ${link}`;
    }
  }

  const history = await getChatHistory(user.id);
  const displayName = user.first_name || 'Client';
  const handshakeKeywordIntent = hasHandshakeKeywordIntent(msgText);

  const masterSkill = getMasterSkill();
  const trialStart = user.trial_start_date ?? user.created_at;
  const trialDay = calculateTrialDay(trialStart);
  const connectionReport = buildConnectionStatusReport(toolbox.connections);
  const googleSuperHandshakeRequired = !googleSuperActive;
  const composioKeyPresent = Boolean(process.env.COMPOSIO_API_KEY);

  const dynamicContext = `
### LIVE USER CONTEXT
- user_id: ${user.id}
- display_name: ${user.first_name || 'Client'}
- trial_start_date: ${trialStart ? new Date(trialStart).toISOString() : 'N/A'}
- current_day_of_trial: ${trialDay != null ? trialDay : 'N/A'}
- subscription_status: ${subscriptionStatus}
- autonomous_execution_enabled: ${subscriptionStatus === 'PRO'}
- connection_status: ${JSON.stringify(connectionReport)}
- google_super_handshake_required: ${!googleSuperActive}
`;
  const lockedOverrideBlock = !googleSuperActive
    ? `
### LOCKED OVERRIDE (google_super)
- google_super is not ACTIVE. Before any Gmail or Google Calendar execute_action, you MUST call initiate_secure_handshake.
`
    : '';
  const finalSystemPrompt = `${ELITE_TRIAGE_SYSTEM_PROMPT}\n\n${masterSkill}\n\n${dynamicContext}${lockedOverrideBlock}`;

  // Hard-wire: never use Claude/tool loop for vault handshake — return OAuth URL immediately
  if (googleSuperHandshakeRequired && handshakeKeywordIntent && composioKeyPresent) {
    try {
      const oauthUrl = await initiateClientConnection(user);
      if (oauthUrl) {
        return `Handshake Initiated. Please authorize your vault here: ${oauthUrl}`;
      }
    } catch (err) {
      console.error('[AUTH] Handshake overrule failed:', err?.message || err);
    }
    return 'Could not generate a vault link. Please try again shortly.';
  }

  const { vault, web, vaultLowConfidence, vaultBestRank } = await search_vault_and_web(msgText, {
    skipTavily: handshakeKeywordIntent ? true : false,
  });

  const vaultBlock = vault.length
    ? vault
        .map((r) => {
          const tags = Array.isArray(r.vibe_tags) ? r.vibe_tags.join(', ') : '';
          const rankBits = [];
          if (typeof r.db_rank === 'number') rankBits.push(`db_rank=${r.db_rank.toFixed(3)}`);
          if (typeof r.tag_score === 'number') rankBits.push(`tag_score=${r.tag_score}`);
          if (typeof r.final_rank === 'number') rankBits.push(`final_rank=${r.final_rank.toFixed(3)}`);
          return `- ${r.name}${r.location ? ` (${r.location})` : ''}${r.category ? ` — ${r.category}` : ''}\n  link: ${r.booking_url || 'N/A'}\n  vibe: ${tags || 'N/A'}\n  note: ${r.description || ''}${rankBits.length ? `\n  _rank: ${rankBits.join(', ')}` : ''}`;
        })
        .join('\n')
    : '- No vault matches found.';

  const webBlock = web.length
    ? web
        .slice(0, 5)
        .map((r) => `- ${r.title || 'Result'}\n  link: ${r.url || 'N/A'}\n  snippet: ${r.content || ''}`)
        .join('\n')
    : '- No web results available.';

  const confidenceNote = vaultLowConfidence
    ? `\n\n[NOTE] Vault rank is low (${vaultBestRank.toFixed(3)}). Rely more heavily on the web results for verified links.`
    : '';
  const toolContext = `Vault recommendations:\n${vaultBlock}\n\nWeb results:\n${webBlock}${confidenceNote}`;

  const messages = [
    { role: 'user', content: `[CONTEXT: User: ${displayName}]` },
    { role: 'user', content: `[TOOL: search_vault_and_web]\n${toolContext}` },
    ...history,
    { role: 'user', content: msgText },
  ];

  console.log('[DEBUG] Final System Prompt being sent to Claude: ', finalSystemPrompt.substring(0, 100));

  return await getHybridResponseFromMessages(messages, msgText, toolbox, user.id, finalSystemPrompt, {
    forceHandshakeToolFirst:
      googleSuperHandshakeRequired &&
      composioKeyPresent &&
      handshakeKeywordIntent &&
      toolbox.anthropicTools?.some((t) => t.name === 'initiate_secure_handshake'),
  });
}

async function getClaudeResponse(userTier, userMessage) {
  const tierInstruction = userTier === 'pro'
    ? "USER_TIER is 'pro'. Follow the pro response rule."
    : "USER_TIER is 'lite'. Follow the lite response rule (recommendation + link, then upsell).";

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: ELITE_TRIAGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${tierInstruction}\n\nUser message:\n${userMessage}`,
      },
    ],
  });

  const textBlock = response.content?.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : 'I have noted your request. A team member will follow up.';
}

function twimlMessage(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}</Message></Response>`;
}

function escapeXml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.post('/webhook', async (req, res) => {
  console.log('--- NEW MESSAGE RECEIVED ---');
  console.log('From:', req.body.From);
  console.log('Body:', req.body.Body);

  try {
    // 1. Database Check
    console.log('Status: Checking Database...');
    const phoneNumber = req.body.From;
    const profileName = req.body.ProfileName || req.body.profileName || null;

    let user = await getUserByPhone(phoneNumber);

    if (!user) {
      console.log('Status: New user detected. Creating Explorer profile...');
      user = await createNewUser(phoneNumber, profileName);
    } else if (!user.first_name && profileName) {
      await pool.query('UPDATE users SET first_name = $1 WHERE id = $2', [profileName, user.id]);
      user.first_name = profileName;
    }

    if (!user.client_id) {
      const cid = await ensureClientIdForUser(user.id);
      if (cid) user.client_id = cid;
    }
    console.log('Status: User identified as:', user.tier);

    const incomingText = String(req.body.Body || '').trim();

    // 2. Conversational upgrade flow
    if (/\b(yes|trial)\b/i.test(incomingText)) {
      const upgradeResponse =
        "Understood. I am notifying the Human Architect to authenticate your Pro Concierge trial and begin your calendar integration. Would you please provide your email address? We will be in touch shortly to finalize the secure link.";

      await sendEmail({
        to: 'assist@ailifeconcierge.co.uk',
        subject: `TRIAL REQUESTED: ${phoneNumber}`,
        text: `Trial requested.\n\nFrom: ${phoneNumber}\nProfileName: ${profileName || ''}\nClientID: ${user.client_id || ''}\nMessage: ${incomingText}\nTier: ${user.tier}\nTimestamp: ${new Date().toISOString()}`,
      });

      await saveConversation(user.id, incomingText, upgradeResponse);

      res.type('text/xml');
      res.send(twimlMessage(upgradeResponse));
      return;
    }

    // 3. Agentic Concierge — single TwiML response only after await completes (no res.send before this)
    console.log('[FLOW] Bypassing Airtable to run Agentic Concierge');
    console.log('Status: Running Agentic Concierge...');
    console.log('[CRITICAL] Waiting for AI response...');
    const aiText = await runAgenticConcierge(user, incomingText);
    console.log('[CRITICAL] AI response received: ', aiText);

    const replyBody =
      typeof aiText === 'string' && aiText.trim() !== ''
        ? aiText
        : 'I have received your message. One moment while I prepare a reply.';

    // 4. Pro subscriber handling: notify Human Architect to authenticate execution
    if (getSubscriptionStatusFromUser(user) === 'PRO') {
      await sendEmail({
        to: 'assist@ailifeconcierge.co.uk',
        subject: `PRO TASK: ${phoneNumber}`,
        text: `Pro task received.\n\nFrom: ${phoneNumber}\nProfileName: ${profileName || ''}\nClientID: ${user.client_id || ''}\nMessage: ${incomingText}\n\nAI response:\n${replyBody}\n\nTimestamp: ${new Date().toISOString()}`,
      });
    }

    // SAVE TO MEMORY
    await saveConversation(user.id, incomingText, replyBody);

    // DISABLED: Airtable sync — re-enable when core bot + field mapping are stable
    // void syncToAirtable({ ... }).catch(...);

    // 5. Twilio Response (only after aiResponse is fully resolved — must follow await above)
    console.log('Status: Sending TwiML back to Twilio...');
    res.type('text/xml');
    res.send(twimlMessage(replyBody));
    console.log('--- WEBHOOK COMPLETE ---');
  } catch (err) {
    console.error('!!! ERROR IN WEBHOOK !!!');
    console.error(err.message);
    res.status(500).send('Error');
  }
});

app.get('/portal', (req, res) => {
  const waUrl =
    'https://wa.me/441483694296?text=' +
    encodeURIComponent(
      "I'm ready to reclaim 10+ hours, but I'm just getting started. What can you help me with?"
    );
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Natural Opening — Ai Life Concierge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      min-height: 100%;
      min-height: -webkit-fill-available;
    }
    body {
      background: #000000;
      color: #D4AF37;
      font-family: "Instrument Serif", Georgia, "Times New Roman", serif;
      -webkit-tap-highlight-color: transparent;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    .stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      width: 100%;
      padding: 1.25rem 1rem 2rem;
    }
    .natural-scene {
      perspective: 1200px;
      -webkit-perspective: 1200px;
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
    }
    .envelope-hit {
      cursor: pointer;
      outline: none;
      display: block;
    }
    .envelope-hit:focus-visible {
      box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.45);
      border-radius: 8px;
    }
    .natural-svg {
      display: block;
      width: 60vw;
      max-width: 380px;
      height: auto;
      overflow: visible;
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
      filter: drop-shadow(0 14px 32px rgba(0, 0, 0, 0.8));
    }
    @media (min-width: 769px) {
      .natural-svg { width: min(340px, 42vw); }
    }
    .natural-flap {
      transform-origin: 160px 118px;
      transform: rotateX(0deg);
      -webkit-transform: rotateX(0deg);
      transition: transform 0.6s ease;
      -webkit-transition: -webkit-transform 0.6s ease;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }
    .natural-root.opened .natural-flap {
      transform: rotateX(180deg);
      -webkit-transform: rotateX(180deg);
    }
    .natural-letter {
      transform: translateY(0);
      transition: transform 0.45s ease 0.3s;
    }
    .natural-root.opened .natural-letter {
      transform: translateY(-40px);
    }
    .footer-msg {
      margin-top: 2rem;
      text-align: center;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 2px;
      line-height: 1.45;
      text-transform: uppercase;
      color: #D4AF37;
      max-width: 24rem;
      padding: 0 0.5rem;
      opacity: 1;
      transition: opacity 0.4s ease;
    }
    @media (max-width: 768px) {
      .footer-msg { font-size: 1.8rem; }
    }
    .footer-msg.switching { opacity: 0; }
  </style>
</head>
<body>
  <div class="stage">
    <div class="natural-root" id="naturalRoot">
      <div class="natural-scene">
        <div class="envelope-hit" id="envelopeBtn" role="button" tabindex="0" aria-label="Open envelope — continue to WhatsApp">
          <svg class="natural-svg" viewBox="0 0 320 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="natCharcoal" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#222"/>
                <stop offset="100%" style="stop-color:#1a1a1a"/>
              </linearGradient>
              <linearGradient id="natSide" x1="0%" y1="100%" x2="100%" y2="0%">
                <stop offset="0%" style="stop-color:#121212"/>
                <stop offset="100%" style="stop-color:#1f1f1f"/>
              </linearGradient>
            </defs>
            <rect width="320" height="260" fill="#000000"/>
            <path fill="#1a1a1a" stroke="#D4AF37" stroke-width="1.8" stroke-linejoin="round"
              d="M32 118 L160 118 L288 118 L288 228 Q288 238 278 238 L42 238 Q32 238 32 228 Z"/>
            <g class="natural-letter">
              <rect x="78" y="148" width="164" height="76" rx="3" fill="#141414" stroke="#D4AF37" stroke-width="1.15"/>
              <line x1="98" y1="168" x2="222" y2="168" stroke="#D4AF37" stroke-width="0.35" opacity="0.45"/>
              <line x1="98" y1="182" x2="198" y2="182" stroke="#D4AF37" stroke-width="0.35" opacity="0.35"/>
              <line x1="98" y1="196" x2="210" y2="196" stroke="#D4AF37" stroke-width="0.35" opacity="0.3"/>
            </g>
            <path fill="url(#natSide)" stroke="#D4AF37" stroke-width="1.35" stroke-linejoin="round" opacity="0.95"
              d="M32 118 L160 200 L32 228 Z"/>
            <path fill="url(#natSide)" stroke="#D4AF37" stroke-width="1.35" stroke-linejoin="round" opacity="0.95"
              d="M288 118 L160 200 L288 228 Z"/>
            <path fill="#1a1a1a" stroke="#D4AF37" stroke-width="1.5" stroke-linejoin="round"
              d="M32 228 L160 155 L288 228"/>
            <g class="natural-flap">
              <path fill="url(#natCharcoal)" stroke="#D4AF37" stroke-width="2" stroke-linejoin="round"
                d="M32 118 L160 38 L288 118 Z"/>
              <path d="M32 118 L160 38 L288 118" fill="none" stroke="#D4AF37" stroke-width="0.85" opacity="0.4"/>
              <line x1="160" y1="48" x2="160" y2="108" stroke="#D4AF37" stroke-width="0.5" opacity="0.25"/>
            </g>
          </svg>
        </div>
      </div>
    </div>
    <p class="footer-msg" id="naturalFooter">YOUR INVITATION TO ACTIVATE AI LIFE CONCIERGE</p>
  </div>
  <script>
    (function () {
      var root = document.getElementById('naturalRoot');
      var btn = document.getElementById('envelopeBtn');
      var footer = document.getElementById('naturalFooter');
      var done = false;
      var wa = ${JSON.stringify(waUrl)};
      function openNatural() {
        if (done) return;
        done = true;
        try {
          if (navigator.vibrate) navigator.vibrate([40, 20, 40]);
        } catch (e) {}
        root.classList.add('opened');
        footer.classList.add('switching');
        setTimeout(function () {
          footer.textContent = 'OPENING YOUR VAULT...';
          footer.classList.remove('switching');
        }, 200);
        setTimeout(function () {
          try {
            window.location.href = wa;
          } catch (err) {
            window.location.assign(wa);
          }
        }, 1100);
      }
      btn.addEventListener('click', openNatural);
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openNatural();
        }
      });
    })();
  </script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-life-concierge' });
});

const PORT = process.env.PORT || 8080; // Changed to 8080 for Railway
(async () => {
  try {
    await runInitScript();
  } catch (dbErr) {
    console.error('Database init failed, but starting server anyway:', dbErr.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
})();
