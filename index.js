require('dotenv').config();
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
const { customAlphabet } = require('nanoid');

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
      try {
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
      } catch (err) {
        // Do not let a transient DB error become an unhandled rejection (process crash).
        // Return 200 so Stripe does not endlessly retry; rely on logs/alerting to reconcile.
        console.error('Stripe webhook DB update failed:', err.message);
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

const generateAiShortIdBody = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  9
);

function buildAiPrefixedShortId() {
  return `Ai-${generateAiShortIdBody()}`;
}

async function ensureShortIdForUser(userId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = buildAiPrefixedShortId();
    try {
      const updated = await pool.query(
        `UPDATE users SET short_id = $1 WHERE id = $2 AND (short_id IS NULL OR short_id = '') RETURNING short_id`,
        [candidate, userId]
      );
      if (updated.rowCount > 0) return updated.rows[0].short_id;
      const existing = await pool.query('SELECT short_id FROM users WHERE id = $1', [userId]);
      return existing.rows[0]?.short_id || null;
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  return null;
}

async function generateOnboardingLink(userId) {
  const sid = await ensureShortIdForUser(userId);
  if (!sid) throw new Error('Could not assign short_id');
  return `https://ailifeconcierge.co.uk/onboarding?client_id=${encodeURIComponent(sid)}`;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const composio = process.env.COMPOSIO_API_KEY ? Composio({ apiKey: process.env.COMPOSIO_API_KEY }) : null;
const googleAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

function getMasterSkill() {
  const skillPath = path.join(__dirname, 'skills', 'sovereign_architect.md');
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    console.error('Master skill file missing/unreadable:', err.message);
    return '';
  }
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

/** PRO/LITE from Postgres `subscription_status` only (no `tier` fallback). */
function getSubscriptionStatusFromUser(user) {
  if (user?.subscription_status != null && String(user.subscription_status).trim() !== '') {
    const u = String(user.subscription_status).trim().toUpperCase();
    return u === 'PRO' ? 'PRO' : 'LITE';
  }
  return 'LITE';
}

/** Strip Twilio WhatsApp prefix for Airtable / display (e.g. whatsapp:+447... → +447...). */
function cleanTwilioSenderPhone(raw) {
  if (raw == null || raw === '') return '';
  return String(raw).replace(/^whatsapp:/i, '').trim();
}

function getAirtableEnvPick(envKey, fallback) {
  const v = process.env[envKey];
  if (v != null && String(v).trim() !== '') return String(v).trim();
  return fallback;
}

function getAirtablePhoneFieldName() {
  return getAirtableEnvPick('AIRTABLE_PHONE_FIELD', 'phone_number');
}

/** Table name (e.g. Users) or table id (tbl…); AIRTABLE_TABLE_NAME takes precedence over AIRTABLE_USER_TABLE_ID. */
function getAirtableTableRef() {
  const byName = process.env.AIRTABLE_TABLE_NAME;
  if (byName != null && String(byName).trim() !== '') return String(byName).trim();
  const byId = process.env.AIRTABLE_USER_TABLE_ID;
  if (byId != null && String(byId).trim() !== '') return String(byId).trim();
  return null;
}

function getAirtableConfig() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = getAirtableEnvPick('AIRTABLE_BASE_ID', '');
  const tableRef = getAirtableTableRef();
  if (!apiKey || !baseId || !tableRef) return null;
  return { apiKey, baseId, tableRef };
}

/** Escape user values embedded in Airtable filterByFormula string literals. */
function escapeAirtableFormulaString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Postgres/Twilio phone → E.164-style string for Airtable single-line text (DB is source of truth). */
function resolveCleanPhoneForAirtable(dbPhone, senderPhone) {
  const fromDb = cleanTwilioSenderPhone(dbPhone);
  const fromSender = cleanTwilioSenderPhone(senderPhone);
  return fromDb || fromSender;
}

/** Normalize Postgres/Airtable calendar provider → google | outlook | null */
function normalizeCalendarProviderValue(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s.includes('outlook') || s.includes('microsoft') || s === 'ms') return 'outlook';
  if (s.includes('google') || s === 'gcal') return 'google';
  if (s === 'outlook' || s === 'google') return s;
  return null;
}

function isCalendarConnected(user) {
  const norm = normalizeCalendarProviderValue(user?.calendar_provider);
  return norm === 'google' || norm === 'outlook';
}

function extractCalendarProviderFromAirtableFields(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const raw =
    fields.CalendarProvider ??
    fields.calendar_provider ??
    fields['Calendar Provider'] ??
    null;
  return normalizeCalendarProviderValue(raw);
}

async function findAirtableRecordsByClientId(clientId) {
  const cid = String(clientId ?? '').trim();
  if (!cid) return [];

  const cfg = getAirtableConfig();
  if (!cfg) return [];

  const formula = `{Client ID}='${escapeAirtableFormulaString(cid)}'`;
  const baseUrl = `https://api.airtable.com/v0/${encodeURIComponent(cfg.baseId)}/${encodeURIComponent(cfg.tableRef)}`;
  const searchUrl = `${baseUrl}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  const text = await searchRes.text();
  if (!searchRes.ok) {
    console.error('[AIRTABLE] client_id search failed:', searchRes.status, text.slice(0, 300));
    return [];
  }
  try {
    const data = text ? JSON.parse(text) : {};
    return (data.records || []).map((r) => ({ id: r.id, fields: r.fields || {} }));
  } catch {
    return [];
  }
}

function mergeAirtableFieldsFromDuplicates(records) {
  const merged = {};
  for (const rec of records) {
    const f = rec.fields || {};
    for (const [key, val] of Object.entries(f)) {
      if (val == null || String(val).trim() === '') continue;
      if (merged[key] == null || String(merged[key]).trim() === '') {
        merged[key] = val;
      }
    }
  }
  return merged;
}

function pickCanonicalAirtableRecord(records) {
  if (!records?.length) return null;
  if (records.length === 1) return records[0];

  const phoneField = getAirtablePhoneFieldName();
  let best = records[0];
  let bestScore = -1;
  for (const rec of records) {
    const f = rec.fields || {};
    let score = 0;
    if (f['Client ID']) score += 10;
    if (f[phoneField]) score += 25;
    if (f.CalendarProvider || f.calendar_provider || f['Calendar Provider']) score += 25;
    score += Object.keys(f).length;
    if (score > bestScore) {
      best = rec;
      bestScore = score;
    }
  }
  return best;
}

async function findAirtableRecordIdByPhone(cleanPhone) {
  if (!cleanPhone) return null;
  const cfg = getAirtableConfig();
  if (!cfg) return null;

  const phoneField = getAirtablePhoneFieldName();
  const formula = `{${phoneField}}='${escapeAirtableFormulaString(cleanPhone)}'`;
  const searchUrl = `https://api.airtable.com/v0/${encodeURIComponent(cfg.baseId)}/${encodeURIComponent(cfg.tableRef)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  const text = await searchRes.text();
  if (!searchRes.ok) return null;
  try {
    const data = text ? JSON.parse(text) : {};
    return data.records?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function findAirtableRecordIdByClientOrPhone({ clientId, cleanPhone }) {
  const cid = String(clientId ?? '').trim();
  if (cid) {
    const records = await findAirtableRecordsByClientId(cid);
    if (records.length > 0) {
      return pickCanonicalAirtableRecord(records).id;
    }
  }
  if (cleanPhone) {
    return findAirtableRecordIdByPhone(cleanPhone);
  }
  return null;
}

/** Strip empty values that would wipe existing Airtable columns on PATCH. */
function sanitizeAirtablePatchFields(fields, existingFields = {}) {
  const out = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val == null) continue;
    if (typeof val === 'string' && val.trim() === '' && existingFields[key]) continue;
    out[key] = val;
  }
  return out;
}

async function upsertAirtableRecord(fields, { clientId, cleanPhone, logTag = 'AIRTABLE' }) {
  const cfg = getAirtableConfig();
  if (!cfg) return false;

  const cid = String(clientId ?? '').trim();
  const baseUrl = `https://api.airtable.com/v0/${encodeURIComponent(cfg.baseId)}/${encodeURIComponent(cfg.tableRef)}`;
  const phoneField = getAirtablePhoneFieldName();

  let duplicates = cid ? await findAirtableRecordsByClientId(cid) : [];
  let recordId = null;
  let existingMerged = {};

  if (duplicates.length > 0) {
    const canonical = pickCanonicalAirtableRecord(duplicates);
    recordId = canonical.id;
    existingMerged = mergeAirtableFieldsFromDuplicates(duplicates);
    if (duplicates.length > 1) {
      console.warn(
        `[${logTag}] ${duplicates.length} Airtable rows share Client ID ${cid}; merging into ${recordId}`
      );
    }
  } else if (cleanPhone) {
    recordId = await findAirtableRecordIdByPhone(cleanPhone);
  }

  const patchFields = sanitizeAirtablePatchFields({ ...fields }, existingMerged);
  if (cid) patchFields['Client ID'] = cid;
  if (cleanPhone) patchFields[phoneField] = cleanPhone;
  else if (existingMerged[phoneField]) patchFields[phoneField] = existingMerged[phoneField];

  if (recordId) {
    const patchRes = await fetch(`${baseUrl}/${recordId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: patchFields, typecast: true }),
    });
    const patchText = await patchRes.text();
    if (!patchRes.ok) {
      console.error(`[${logTag}] PATCH failed:`, patchRes.status, patchText.slice(0, 400));
      return false;
    }
    if (logTag === 'AIRTABLE_LEAD') {
      console.log(
        `[AIRTABLE_LEAD] synced record ${recordId} | Client ID: ${cid || '(none)'} | phone: ${cleanPhone || existingMerged[phoneField] || '(none)'}`
      );
    }
    return true;
  }

  if (cid) {
    duplicates = await findAirtableRecordsByClientId(cid);
    if (duplicates.length > 0) {
      console.error(`[${logTag}] refused create: Client ID ${cid} already exists (${duplicates.length} row(s))`);
      return upsertAirtableRecord(fields, { clientId: cid, cleanPhone, logTag });
    }
  }

  if (!cid && !cleanPhone) {
    console.warn(`[${logTag}] skipped: no client_id or phone to anchor record`);
    return false;
  }

  const createRes = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields: patchFields }], typecast: true }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    console.error(`[${logTag}] POST failed:`, createRes.status, createText.slice(0, 400));
    return false;
  }
  if (logTag === 'AIRTABLE_LEAD') {
    let newId = '(unknown)';
    try {
      const created = createText ? JSON.parse(createText) : {};
      newId = created.records?.[0]?.id || newId;
    } catch {
      /* ignore */
    }
    console.log(`[AIRTABLE_LEAD] created record ${newId} | Client ID: ${cid || '(none)'}`);
  }
  return true;
}

/** Keep Client ID + phone_number anchored in Airtable (idempotent, runs each message). */
async function seedAirtableLeadRecord(user, senderPhoneNumber) {
  const cfg = getAirtableConfig();
  if (!cfg) return false;

  const clientId = user?.short_id || user?.client_id || null;
  const cleanPhone = resolveCleanPhoneForAirtable(user?.phone_number, senderPhoneNumber);
  if (!cleanPhone) return false;

  const phoneField = getAirtablePhoneFieldName();
  const fields = {
    'Client ID': clientId || '',
    [phoneField]: cleanPhone,
  };

  return upsertAirtableRecord(fields, {
    clientId,
    cleanPhone,
    logTag: 'AIRTABLE_LEAD',
  });
}

/** Fetch merged Airtable row fields by Client ID (deduplicates split rows in memory). */
async function fetchAirtableRecordFieldsByClientId(clientId) {
  const cid = String(clientId ?? '').trim();
  if (!cid) return null;

  const records = await findAirtableRecordsByClientId(cid);
  if (records.length > 0) {
    return mergeAirtableFieldsFromDuplicates(records);
  }
  return null;
}

/**
 * Pull CalendarProvider (+ optional phone) from Airtable by client_id; write calendar_provider to Postgres.
 */
async function syncCalendarFromAirtableForUser(userId, clientId) {
  const cid = String(clientId ?? '').trim();
  if (!cid) return null;

  const records = await findAirtableRecordsByClientId(cid);
  if (!records.length) return null;

  const merged = mergeAirtableFieldsFromDuplicates(records);
  const calendarProvider = extractCalendarProviderFromAirtableFields(merged);
  const phoneField = getAirtablePhoneFieldName();
  const mergedPhone = merged[phoneField] ? cleanTwilioSenderPhone(merged[phoneField]) : null;

  if (calendarProvider) {
    await pool.query(
      `UPDATE users SET calendar_provider = $1, architecture_synced_at = NOW() WHERE id = $2::uuid`,
      [calendarProvider, userId]
    );
    console.log('[SYNC] calendar_provider from Airtable:', calendarProvider, 'user:', userId);
  }

  if (records.length > 1) {
    const canonical = pickCanonicalAirtableRecord(records);
    const phoneFieldName = getAirtablePhoneFieldName();
    const repairFields = { 'Client ID': cid };
    if (merged[phoneFieldName]) repairFields[phoneFieldName] = merged[phoneFieldName];
    if (merged.CalendarProvider || merged.calendar_provider) {
      repairFields.CalendarProvider = merged.CalendarProvider || merged.calendar_provider;
    }
    await upsertAirtableRecord(repairFields, {
      clientId: cid,
      cleanPhone: mergedPhone,
      logTag: 'AIRTABLE_MERGE',
    });
  }

  return {
    calendarProvider,
    mergedPhone,
    duplicateCount: records.length,
    activeAutomations: merged.ActiveAutomations ?? merged.active_automations ?? null,
  };
}

function isOnboardingPending(user) {
  const status =
    user?.onboarding_status != null && String(user.onboarding_status).trim() !== ''
      ? String(user.onboarding_status).trim()
      : 'pending';
  return status === 'pending';
}

/** Canonical automation slugs (WhatsApp + Airtable + Postgres). */
const CANONICAL_AUTOMATION_SLUGS = new Set(['date_night', 'gifting', 'travel_logistics']);

/** Map web/Airtable legacy slugs → canonical slugs. */
const LEGACY_AUTOMATION_SLUG_MAP = {
  flowers_card_delivery: 'gifting',
  milestone_proposals: 'gifting',
  flowers: 'gifting',
  milestones: 'gifting',
  gifting: 'gifting',
  date_night: 'date_night',
  travel_logistics: 'travel_logistics',
  travel: 'travel_logistics',
};

function normalizeAutomationSlugs(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : [];
  const out = new Set();
  for (const item of raw) {
    const s = String(item).trim().toLowerCase();
    if (!s) continue;
    const canonical = LEGACY_AUTOMATION_SLUG_MAP[s] || s;
    if (CANONICAL_AUTOMATION_SLUGS.has(canonical)) {
      out.add(canonical);
    }
  }
  return [...out];
}

function formatAutomationSlugList(slugs) {
  const normalized = normalizeAutomationSlugs(slugs);
  return normalized.length ? normalized.join(', ') : 'None';
}

function needsDateNightIntake(user) {
  const prefs = parseUserJsonbObject(user?.preferences);
  if (prefs.date_night && typeof prefs.date_night === 'object') return false;
  if (prefs.date_night_intake_required === true) return true;
  const automations = normalizeAutomationSlugs(parseUserJsonbArray(user?.active_automations));
  return automations.includes('date_night') && !isOnboardingPending(user);
}

function buildAutomationIntakePending(user) {
  const automations = normalizeAutomationSlugs(parseUserJsonbArray(user?.active_automations));
  const prefs = parseUserJsonbObject(user?.preferences);
  const pending = [];
  if (automations.includes('date_night') && !prefs.date_night) {
    pending.push(
      'date_night: neighborhood, cuisine dislikes, budget tier, dietary restrictions; then check_calendar_availability'
    );
  }
  if (automations.includes('gifting') && !prefs.gifting) {
    pending.push('gifting: recipient name, relationship, milestone date, delivery address');
  }
  if (automations.includes('travel_logistics') && !prefs.travel_logistics) {
    pending.push(
      'travel_logistics: destination, duration, travel style, hard constraints; then check_calendar_availability'
    );
  }
  return pending.length ? pending.join(' | ') : 'none';
}

function buildEliteTriageSystemPrompt() {
  const systemTime = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  return `[SYSTEM PROTOCOL] Current System Time: ${systemTime}. The master location is Horley, England (RH6). All temporal calculations (tomorrow, next week, current trial status) must be based strictly on this timestamp.

ROLE: Alice, The Lifestyle Architect
Persona: You are an elite, predictive AI concierge. You do not "help"; you "engineer outcomes." Your communication is concise, logical, and void of conversational filler.

### LIVE STATE (READ FIRST)
The Node.js backend injects LIVE USER CONTEXT on every message. Trust it absolutely. Do not ask the user for information already present there (email, Client ID, calendar_provider, Active Automations, onboarding phase). Do not instruct the user to call external webhooks or Pipedream — the backend syncs Airtable and calendar state before you respond.

1. SOVEREIGN LIFECYCLE & STATE
You have access to the user's LIVE STATE via the context block provided by the system.
- Founding Member Trial: 180 days of full autonomous execution. Compare the Current System Time against the user's trial_start_date / created_at and days_since_enrollment in LIVE USER CONTEXT.
- Lite Phase: If the 180-day founding_member_180_window is false and subscription_status is not PRO, downgrade to research-only mode. Inform the user: "Autonomous layer expired. Upgrade to reactivate execution."

2. CALENDAR PROTOCOL & OPPORTUNITY SCANNING
If LIVE USER CONTEXT shows Calendar Connected: True, you are a temporal architect. You CANNOT infer availability from text alone.
- Mandatory Tool: Before proposing ANY specific date, time, reservation window, or itinerary slot, you MUST call check_calendar_availability with ISO 8601 start_time and end_time covering the proposed window, plus intent (e.g. "date night proposal").
- Wait for the tool result. Only propose times that fall within returned free/busy gaps. Never propose slots that overlap busy periods.
- Contextual Awareness: If the user says "next weekend", calculate exact dates from Current System Time, then call check_calendar_availability for that range before suggesting options.
- Use execute_pipedream_calendar_task only for explicit calendar writes (create_event) after availability is confirmed. Never use Composio execute_action for calendar reads or writes. OAuth is web-only via calendar_onboarding_link.

3. THE SECURE HANDSHAKE (SYNC PROTOCOL)
When a user provides the activation phrase: "I've now connected my calendar and enabled my automations - please sync systems to activate."
- Read LIVE USER CONTEXT (already updated by the backend). Do not call fetch_architecture_profile unless architecture_synced_at is N/A and calendar_provider is missing.
- Acknowledge: "Logic staged. I have identified your [Google/Outlook] sync and initialized [Active Automations from context]. I am now engineering your first outcome."

4. CORE SKILL: THE "HORLEY" STANDARD (Logistics)
For every physical request (flowers, dining, services):
- Verify Location: Use vault and web search results to find top-tier options.
- Verify Coverage: Scan business websites for "RH6", "Horley", or "Surrey".
- Availability: Cross-reference operating hours against the user's connected calendar when scheduling.

5. REQUEST QUALIFICATION & FALLBACK
Constraint Check: If a request has 5+ variables or requires physical presence beyond digital booking, trigger Human Fallback.
Fallback Routing: End with handover to assist@ailifeconcierge.co.uk.
Logic: "This request requires a human execution layer. Staging hand-off to the concierge desk now."

### CALENDAR VAULT LINK (web OAuth only)
When the user must connect their calendar, respond with exactly (substitute calendar_onboarding_link from LIVE USER CONTEXT for [LINK]):
I've prepared your secure vault access. Please complete the handshake here to sync your calendar: [LINK]

### CONVERSATIONAL ONBOARDING PROTOCOL
Trigger: LIVE USER CONTEXT shows Onboarding Status: pending OR onboarding_phase < 8.
Execution: One phase per message. Wait for reply before advancing. Use onboarding_phase in LIVE USER CONTEXT as your anchor.

Phase 1 (Identity): Welcome. Ask for first and last name and preferred email.
Phase 2 (Profile): Ask which profile fits (1–4): Founder/CEO, Executive/Professional, Investor/Family Office, Creative/Artist.
Phase 3 (Friction): Map reply. Ask where to deploy value (1–4): Relationship & Milestone Management, Event & Lifestyle Curation, Bespoke Sourcing, Coordinating Logistics. If user picks multiple, store the primary in friction_points and note secondary in conversation.
Phase 4 (Commitment): Map reply. Ask partnership structure (1–3): fully-managed lifestyle partner, self-hosted/DIY AI tools, team/office exploration.
Phase 5 (Calendar): Do not pitch automations until calendar is connected. Send Vault link. Stay here while Calendar Connected is False in LIVE USER CONTEXT.
Phase 6 (Verification): Backend sync is complete when Calendar Provider is Google or Outlook in LIVE USER CONTEXT. Read Active Automations from context — do not call fetch_architecture_profile unless data is missing.
Phase 7 (Automations): Pitch flagship automations (canonical slugs only):
• date_night — bi-weekly recommendations, calendar conflict checking, booking staging
• gifting — milestone and key-date curation
• travel_logistics — flight detection, itinerary buffers, ground transport
Lead with automations matching Phase 3 friction. Wait for explicit choices.
Phase 8 (Commit): Call save_onboarding_profile with Phases 1–4 as human-readable strings (not menu numbers) and active_automations as canonical slugs only: date_night, gifting, travel_logistics. Then say: "Profile architected successfully. I am ready for your first request."

### FLAGSHIP AUTOMATION FRAMEWORK
When Active Automations in LIVE USER CONTEXT includes a slug below, run that automation's intake protocol before execution. Check automation_intake_pending in LIVE USER CONTEXT. One automation at a time unless the user requests multiple.

General Rule: For any automation involving dates or times, complete intake first, then call check_calendar_availability before proposing specific slots.

**date_night** (slug: date_night)
Intake required: preferred neighborhood(s), cuisine dislikes, budget tier, dietary restrictions.
Then: call check_calendar_availability for the target evening window before proposing a date night slot.
When complete: call save_date_night_preferences.

**gifting** (slug: gifting)
Intake required: recipient name, relationship to user, upcoming milestone/date, delivery address.
Store answers in conversation until a gifting preferences tool exists; confirm summary with the user before staging curation.

**travel_logistics** (slug: travel_logistics)
Intake required: destination, trip duration, preferred travel style (e.g. boutique vs luxury resort), hard constraints (dates, budget cap, accessibility).
Then: call check_calendar_availability across the travel window to identify conflicts with existing commitments before proposing itinerary.

### DATE NIGHT INTAKE (POST PHASE 8)
If date_night_intake_required: true, begin date_night intake immediately after save_onboarding_profile per the framework above.

Constraint: Elite, professional tone. Economical language. No emojis.`;
}

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

const SAVE_ONBOARDING_PROFILE_ANTHROPIC_TOOL = {
  name: 'save_onboarding_profile',
  description:
    'Persist completed conversational onboarding: identity, profile, friction focus, partnership commitment, and automation slugs agreed in Phase 7. Call only after Phase 8 (calendar verified, automation pitch complete) with human-readable string values (not numeric menu codes).',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: 'User first name.' },
      last_name: { type: 'string', description: 'User last name.' },
      email: { type: 'string', description: 'User preferred email.' },
      occupation: {
        type: 'string',
        description:
          'Profile label: Founder / CEO, Executive / Professional, Investor / Family Office, or Creative / Artist.',
      },
      friction_points: {
        type: 'string',
        enum: [
          'Coordinating Logistics',
          'Bespoke Sourcing',
          'Event & Lifestyle Curation',
          'Relationship & Milestone Management',
        ],
        description:
          "You MUST categorize the user's primary friction point into exactly one of these pre-approved categories. Do not invent your own category.",
      },
      service_commitment: {
        type: 'string',
        description:
          'Partnership structure: fully-managed lifestyle partner, self-hosted/DIY AI tools, or team/office exploration.',
      },
      active_automations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Canonical automation slugs only: date_night, gifting, travel_logistics (legacy web slugs are normalized automatically).',
      },
      preferences: {
        type: 'object',
        description:
          'Optional. Nested key-value automation preferences (e.g. date_night cuisine, budget). Defaults to empty object.',
      },
    },
    required: ['first_name', 'last_name', 'email', 'occupation', 'friction_points', 'service_commitment'],
  },
};

const SAVE_DATE_NIGHT_PREFERENCES_ANTHROPIC_TOOL = {
  name: 'save_date_night_preferences',
  description:
    'Persist Date Night automation preferences after intake: neighborhood, budget, cuisines, and dietary restrictions. Call once all four are collected from the user.',
  input_schema: {
    type: 'object',
    properties: {
      neighborhood: { type: 'string', description: 'Preferred area (e.g. Soho, Mayfair).' },
      budget: { type: 'string', description: 'Average spend (e.g. "£150 total", "£££").' },
      cuisines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Favorite cuisines (e.g. ["Italian", "Sushi"]).',
      },
      dietary_restrictions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dietary needs (e.g. ["Gluten-free"] or ["None"]).',
      },
    },
    required: ['neighborhood', 'budget', 'cuisines', 'dietary_restrictions'],
  },
};

const EXECUTE_ACTION_ANTHROPIC_TOOL = {
  name: 'execute_action',
  description:
    'Composio integration actions for this user: email, CRM, and non-calendar automation. NOT for Google Calendar, Outlook calendar, events, meetings, free/busy, or scheduling — the backend rejects calendar-like tool slugs; use execute_pipedream_calendar_task for those. Requires tool_slug, arguments, and connected_account_id when needed. Not for OAuth.',
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

const FETCH_ARCHITECTURE_PROFILE_ANTHROPIC_TOOL = {
  name: 'fetch_architecture_profile',
  description:
    'Retrieves registry data when LIVE USER CONTEXT is stale. The backend normally syncs Airtable before you respond — prefer reading calendar_provider and Active Automations from LIVE USER CONTEXT. Only call if architecture_synced_at is N/A or the user explicitly requests re-sync.',
  input_schema: {
    type: 'object',
    properties: {
      client_id: { type: 'string', description: 'Client identifier (e.g. Ai-XXXXXX from the user record).' },
    },
    required: ['client_id'],
  },
};

function getArchitectureProfileAnthropicTools() {
  const hasAirtable =
    process.env.AIRTABLE_API_KEY &&
    getAirtableEnvPick('AIRTABLE_BASE_ID', '') &&
    getAirtableEnvPick('AIRTABLE_TABLE_NAME', '');
  const hasPipedream = process.env.FETCH_ARCHITECTURE_PROFILE_URL;
  if (!hasAirtable && !hasPipedream) return [];
  return [FETCH_ARCHITECTURE_PROFILE_ANTHROPIC_TOOL];
}

/**
 * POST { client_id } to the architecture profile Pipedream URL. Set FETCH_ARCHITECTURE_PROFILE_URL.
 * Optional: FETCH_ARCHITECTURE_PROFILE_TOKEN or PIPEDREAM_ARCHITECTURE_PROFILE_TOKEN (Bearer), PIPEDREAM_ENVIRONMENT.
 */
async function fetchArchitectureProfileFromPipedream(clientId) {
  const url = process.env.FETCH_ARCHITECTURE_PROFILE_URL;
  if (!url || !String(url).trim()) {
    return JSON.stringify({
      error: 'fetch_architecture_profile is not configured (set FETCH_ARCHITECTURE_PROFILE_URL)',
    });
  }
  const cid = String(clientId ?? '').trim();
  if (!cid) {
    return JSON.stringify({ error: 'client_id is required' });
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.FETCH_ARCHITECTURE_PROFILE_TOKEN || process.env.PIPEDREAM_ARCHITECTURE_PROFILE_TOKEN;
  if (token != null && String(token).trim() !== '') {
    headers.Authorization = `Bearer ${String(token).trim()}`;
  }
  const pdEnv = process.env.PIPEDREAM_ENVIRONMENT;
  if (pdEnv != null && String(pdEnv).trim() !== '') {
    headers['x-pd-environment'] = String(pdEnv).trim();
  }
  try {
    const res = await fetch(String(url).trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id: cid }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) {
      return JSON.stringify({
        error: `HTTP ${res.status}`,
        body: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      });
    }
    return text.length > 12000 ? `${text.slice(0, 12000)}\n…[truncated]` : text;
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

/**
 * Architecture profile for systems handshake — Airtable first (no Pipedream required), Pipedream optional fallback.
 */
async function fetchArchitectureProfile(clientId) {
  const cid = String(clientId ?? '').trim();
  if (!cid) {
    return JSON.stringify({ error: 'client_id is required' });
  }

  const airtableFields = await fetchAirtableRecordFieldsByClientId(cid);
  if (airtableFields) {
    const payload = {
      client_id: cid,
      source: 'airtable',
      CalendarProvider:
        airtableFields.CalendarProvider ??
        airtableFields.calendar_provider ??
        airtableFields['Calendar Provider'] ??
        null,
      ActiveAutomations: normalizeAutomationSlugs(
        airtableFields.ActiveAutomations ??
          airtableFields.active_automations ??
          airtableFields['Active Automations'] ??
          []
      ),
    };
    console.log('[SYNC] Architecture profile loaded from Airtable for', cid);
    return JSON.stringify(payload);
  }

  const pipedreamUrl = process.env.FETCH_ARCHITECTURE_PROFILE_URL;
  if (pipedreamUrl && String(pipedreamUrl).trim()) {
    console.log('[SYNC] Airtable miss; trying Pipedream for', cid);
    return fetchArchitectureProfileFromPipedream(cid);
  }

  return JSON.stringify({
    error: 'Architecture profile not found in Airtable',
    client_id: cid,
    hint: 'Complete web onboarding or finish WhatsApp onboarding to populate the registry.',
  });
}

/**
 * Pipedream profile JSON → CalendarProvider + ActiveAutomations. Keys may be camelCase or snake_case.
 * Returns { calendarProvider, activeAutomations } for persistence on users.
 */
function extractArchitectureSessionFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { calendarProvider: null, activeAutomations: null };
  }
  if (data.error) return { calendarProvider: null, activeAutomations: null };
  const cal =
    data.CalendarProvider ?? data.calendarProvider ?? data.calendar_provider ?? null;
  const auto =
    data.ActiveAutomations ?? data.activeAutomations ?? data.active_automations ?? null;
  return {
    calendarProvider: normalizeCalendarProviderValue(cal),
    activeAutomations: auto,
  };
}

/**
 * Parse successful Pipedream body text; persist to users. Returns { calendarProvider, activeAutomations } or null.
 */
async function persistArchitectureSessionFromPipedreamResponse(userId, rawText, options = {}) {
  const { preserveAutomations = false } = options;
  const id = String(userId ?? '').trim();
  if (!id || rawText == null) return null;
  const t = String(rawText).trim();
  if (t.length === 0) return null;
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }
  if (data && typeof data === 'object' && data.error) return null;
  const { calendarProvider, activeAutomations } = extractArchitectureSessionFields(data);
  const calStr = calendarProvider;
  const normalizedAutos = normalizeAutomationSlugs(activeAutomations);
  const autoJson = JSON.stringify(normalizedAutos);

  try {
    if (preserveAutomations) {
      await pool.query(
        `UPDATE users SET calendar_provider = $1, architecture_synced_at = NOW() WHERE id = $2::uuid`,
        [calStr, id]
      );
    } else {
      await pool.query(
        `UPDATE users SET calendar_provider = $1, active_automations = $2::jsonb, architecture_synced_at = NOW() WHERE id = $3::uuid`,
        [calStr, autoJson, id]
      );
    }
  } catch (err) {
    console.error('[SYNC] persist architecture session failed:', err?.message || err);
    return null;
  }
  return {
    calendarProvider: calStr,
    activeAutomations: preserveAutomations ? null : autoJson,
  };
}

async function resetOnboardingState(userId) {
  await pool.query(
    `UPDATE users
     SET onboarding_status = 'pending',
         onboarding_phase = 1,
         active_automations = '[]'::jsonb,
         preferences = '{}'::jsonb
     WHERE id = $1`,
    [userId]
  );
  console.log('[ONBOARDING] reset for user:', userId);
}

const PIPEDREAM_CALENDAR_ACTIONS = ['read_calendar', 'create_event', 'find_slot'];

const CHECK_CALENDAR_AVAILABILITY_ANTHROPIC_TOOL = {
  name: 'check_calendar_availability',
  description:
    'Query the user calendar free/busy for a time window via Pipedream. REQUIRED before proposing any specific date, time, or reservation. The backend resolves client_id from the user record. Returns busy periods and free gaps.',
  input_schema: {
    type: 'object',
    properties: {
      start_time: {
        type: 'string',
        description: 'Window start in ISO 8601 (e.g. 2026-07-05T18:00:00+01:00).',
      },
      end_time: {
        type: 'string',
        description: 'Window end in ISO 8601 (e.g. 2026-07-05T23:00:00+01:00).',
      },
      intent: {
        type: 'string',
        description: 'Purpose of the scan (e.g. "date night proposal", "travel conflict check").',
      },
    },
    required: ['start_time', 'end_time', 'intent'],
  },
};

const EXECUTE_PIPEDREAM_CALENDAR_TASK_ANTHROPIC_TOOL = {
  name: 'execute_pipedream_calendar_task',
  description:
    "Sends a command to Pipedream to read or write the user's Google/Outlook calendar. After fetch_architecture_profile, align with CalendarProvider. Use client_id from LIVE USER CONTEXT.",
  input_schema: {
    type: 'object',
    properties: {
      client_id: { type: 'string', description: 'Client identifier (e.g. Ai-XXXXXX from the user record).' },
      action: {
        type: 'string',
        enum: PIPEDREAM_CALENDAR_ACTIONS,
        description:
          'read_calendar: view/range; create_event: book/schedule; find_slot: user wants a gap/availability (e.g. "find a gap") use find_slot, ("book this") use create_event.',
      },
      details: {
        type: 'string',
        description:
          'Times, dates, event titles, time zones. State CalendarProvider (from fetch_architecture_profile) so Pipedream uses the right backend.',
      },
    },
    required: ['client_id', 'action', 'details'],
  },
};

function getPipedreamCalendarAnthropicTools() {
  const url = process.env.PIPEDREAM_CALENDAR_URL || process.env.EXECUTE_PIPEDREAM_CALENDAR_TASK_URL;
  if (!url || !String(url).trim()) return [];
  return [EXECUTE_PIPEDREAM_CALENDAR_TASK_ANTHROPIC_TOOL];
}

function getCalendarAvailabilityAnthropicTools() {
  return [CHECK_CALENDAR_AVAILABILITY_ANTHROPIC_TOOL];
}

/**
 * POST free/busy query to Pipedream. Set PIPEDREAM_CALENDAR_QUERY_WEBHOOK.
 * Body: { client_id, start_time, end_time, intent, calendar_provider? }
 */
async function checkCalendarAvailability(userId, toolInput) {
  const url = process.env.PIPEDREAM_CALENDAR_QUERY_WEBHOOK;
  if (!url || !String(url).trim()) {
    return JSON.stringify({
      error: 'Calendar availability webhook not configured (set PIPEDREAM_CALENDAR_QUERY_WEBHOOK)',
      available: false,
    });
  }

  const start_time = String(toolInput?.start_time ?? '').trim();
  const end_time = String(toolInput?.end_time ?? '').trim();
  const intent = String(toolInput?.intent ?? '').trim();

  if (!start_time || !end_time) {
    return JSON.stringify({
      error: 'start_time and end_time are required (ISO 8601)',
      available: false,
    });
  }

  const { rows } = await pool.query(
    'SELECT short_id, client_id, calendar_provider FROM users WHERE id = $1',
    [userId]
  );
  const userRow = rows[0] || {};
  const clientId = userRow.short_id || userRow.client_id || null;
  if (!clientId) {
    return JSON.stringify({
      error: 'client_id not found for user — complete onboarding first',
      available: false,
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  const token =
    process.env.PIPEDREAM_CALENDAR_QUERY_TOKEN ||
    process.env.PIPEDREAM_CALENDAR_TOKEN ||
    process.env.PIPEDREAM_ARCHITECTURE_PROFILE_TOKEN;
  if (token != null && String(token).trim() !== '') {
    headers.Authorization = `Bearer ${String(token).trim()}`;
  }
  const pdEnv = process.env.PIPEDREAM_ENVIRONMENT;
  if (pdEnv != null && String(pdEnv).trim() !== '') {
    headers['x-pd-environment'] = String(pdEnv).trim();
  }

  const body = {
    client_id: clientId,
    start_time,
    end_time,
    intent: intent || 'availability check',
    calendar_provider: userRow.calendar_provider || null,
  };

  try {
    const res = await fetch(String(url).trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('[CALENDAR] availability HTTP', res.status, text.slice(0, 500));
      return JSON.stringify({
        error: `HTTP ${res.status}`,
        available: false,
        body: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      });
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : { raw: text };
    } catch {
      parsed = { raw: text };
    }
    return JSON.stringify({
      ok: true,
      client_id: clientId,
      start_time,
      end_time,
      intent: body.intent,
      ...((typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed : { data: parsed }),
    });
  } catch (err) {
    console.error('[CALENDAR] availability failed:', err?.message || err);
    return JSON.stringify({
      error: err.message || String(err),
      available: false,
    });
  }
}

/**
 * POST { client_id, action, details } to the Pipedream HTTP trigger. Set PIPEDREAM_CALENDAR_URL
 * to the full URL (e.g. https://xxx.m.pipedream.net). Optional: PIPEDREAM_CALENDAR_TOKEN (Bearer), PIPEDREAM_ENVIRONMENT.
 */
async function executePipedreamCalendarTask(input) {
  const url = process.env.PIPEDREAM_CALENDAR_URL || process.env.EXECUTE_PIPEDREAM_CALENDAR_TASK_URL;
  if (!url || !String(url).trim()) {
    return JSON.stringify({
      error: 'Pipedream calendar URL is not configured (set PIPEDREAM_CALENDAR_URL)',
    });
  }
  const client_id = String(input?.client_id ?? '').trim();
  const action = input?.action;
  const details = String(input?.details ?? '');
  if (!client_id) {
    return JSON.stringify({ error: 'client_id is required' });
  }
  if (!PIPEDREAM_CALENDAR_ACTIONS.includes(action)) {
    return JSON.stringify({ error: `action must be one of: ${PIPEDREAM_CALENDAR_ACTIONS.join(', ')}` });
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.PIPEDREAM_CALENDAR_TOKEN;
  if (token != null && String(token).trim() !== '') {
    headers.Authorization = `Bearer ${String(token).trim()}`;
  }
  const pdEnv = process.env.PIPEDREAM_ENVIRONMENT;
  if (pdEnv != null && String(pdEnv).trim() !== '') {
    headers['x-pd-environment'] = String(pdEnv).trim();
  }
  try {
    const res = await fetch(String(url).trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id, action, details }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) {
      return JSON.stringify({
        error: `HTTP ${res.status}`,
        body: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      });
    }
    return text.length > 12000 ? `${text.slice(0, 12000)}\n…[truncated]` : text;
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

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

async function saveOnboardingProfile(userId, toolInput, senderPhoneNumber = null) {
  const first_name = String(toolInput?.first_name ?? '').trim();
  const last_name = String(toolInput?.last_name ?? '').trim();
  const email = String(toolInput?.email ?? '').trim();
  const occupation = String(toolInput?.occupation ?? '').trim();
  const friction_points = String(toolInput?.friction_points ?? '').trim();
  const service_commitment = String(toolInput?.service_commitment ?? '').trim();
  const normalizedAutomations = normalizeAutomationSlugs(toolInput?.active_automations || []);
  const incomingPrefs =
    toolInput?.preferences != null &&
    typeof toolInput.preferences === 'object' &&
    !Array.isArray(toolInput.preferences)
      ? toolInput.preferences
      : {};
  const preferences = {
    ...incomingPrefs,
    profile: {
      occupation,
      friction_points,
      service_commitment,
    },
    date_night_intake_required: normalizedAutomations.includes('date_night'),
  };

  await pool.query(
    `UPDATE users
     SET first_name = $1,
         last_name = $2,
         email = $3,
         onboarding_status = 'complete',
         onboarding_phase = 8,
         active_automations = $5::jsonb,
         preferences = $6::jsonb
     WHERE id = $4`,
    [
      first_name,
      last_name,
      email,
      userId,
      JSON.stringify(normalizedAutomations),
      JSON.stringify(preferences),
    ]
  );

  const { rows } = await pool.query(
    'SELECT phone_number, short_id, client_id FROM users WHERE id = $1',
    [userId]
  );
  const userRow = rows[0] || {};
  const clientIdForAirtable = userRow.short_id || userRow.client_id || null;
  const cleanPhoneNumber = resolveCleanPhoneForAirtable(userRow.phone_number, senderPhoneNumber);

  if (cleanPhoneNumber && senderPhoneNumber) {
    const twilioPhone = String(senderPhoneNumber).trim().startsWith('whatsapp:')
      ? String(senderPhoneNumber).trim()
      : `whatsapp:${cleanPhoneNumber}`;
    await pool.query(
      `UPDATE users SET phone_number = COALESCE(NULLIF(phone_number, ''), $1) WHERE id = $2`,
      [twilioPhone, userId]
    );
  }

  const sendGridKey = process.env.SENDGRID_API_KEY;
  if (sendGridKey && email) {
    try {
      const sendGridRes = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${sendGridKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contacts: [{ email, first_name, last_name }],
        }),
      });
      if (!sendGridRes.ok) {
        const text = await sendGridRes.text();
        console.error('[ONBOARDING] SendGrid HTTP', sendGridRes.status, text.slice(0, 500));
      }
    } catch (err) {
      console.error('[ONBOARDING] SendGrid sync failed:', err?.message || err);
    }
  }

  if (getAirtableConfig()) {
    try {
      const phoneFieldName = getAirtablePhoneFieldName();
      const airtableFields = {
        'Client ID': clientIdForAirtable,
        [phoneFieldName]: cleanPhoneNumber,
        Occupation: occupation,
        'Friction Points': friction_points,
        'Service Commitment': service_commitment,
        ActiveAutomations: JSON.stringify(normalizedAutomations),
        Preferences: JSON.stringify(preferences || {}),
      };

      if (!cleanPhoneNumber) {
        console.warn('[ONBOARDING] Skipping Airtable upsert: missing phone_number', {
          userId,
          dbPhone: userRow.phone_number,
          senderPhone: senderPhoneNumber,
        });
      } else {
        await upsertAirtableRecord(airtableFields, {
          clientId: clientIdForAirtable,
          cleanPhone: cleanPhoneNumber,
          logTag: 'ONBOARDING',
        });
      }
    } catch (err) {
      console.error('[ONBOARDING] Airtable sync failed:', err?.message || err);
    }
  }

  const dateNightIntakeRequired = normalizedAutomations.includes('date_night');

  return JSON.stringify({
    success: true,
    date_night_intake_required: dateNightIntakeRequired,
    active_automations: normalizedAutomations,
    message: dateNightIntakeRequired
      ? 'Onboarding profile committed. Begin Date Night intake immediately in your next reply (neighborhood, budget, cuisines, dietary restrictions), then call save_date_night_preferences.'
      : 'Onboarding profile committed to the database (onboarding_status: complete). Marketing and operational records synced when configured.',
  });
}

function parseUserJsonbArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseUserJsonbObject(value) {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function saveDateNightPreferences(userId, toolInput) {
  const neighborhood = String(toolInput?.neighborhood ?? '').trim();
  const budget = String(toolInput?.budget ?? '').trim();
  const cuisines = Array.isArray(toolInput?.cuisines)
    ? toolInput.cuisines.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const dietary_restrictions = Array.isArray(toolInput?.dietary_restrictions)
    ? toolInput.dietary_restrictions.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const { rows } = await pool.query(
    'SELECT preferences, phone_number, short_id, client_id FROM users WHERE id = $1',
    [userId]
  );
  const userRow = rows[0] || {};
  const currentPreferences = parseUserJsonbObject(userRow.preferences);
  const updatedPreferences = {
    ...currentPreferences,
    date_night: { neighborhood, budget, cuisines, dietary_restrictions },
    date_night_intake_required: false,
  };

  await pool.query('UPDATE users SET preferences = $1::jsonb WHERE id = $2', [
    JSON.stringify(updatedPreferences),
    userId,
  ]);

  const clientIdForAirtable = userRow.short_id || userRow.client_id || null;
  const cleanPhone = resolveCleanPhoneForAirtable(userRow.phone_number, null);

  if (getAirtableConfig() && clientIdForAirtable) {
    try {
      await upsertAirtableRecord(
        { Preferences: JSON.stringify(updatedPreferences) },
        { clientId: clientIdForAirtable, cleanPhone, logTag: 'DATE_NIGHT' }
      );
      console.log('[DATE_NIGHT] Airtable preferences updated via client_id upsert');
    } catch (error) {
      console.error('Airtable update failed:', error);
    }
  }

  return JSON.stringify({
    success: true,
    message: 'Date Night preferences saved to the database and synced to operational records when configured.',
    date_night: updatedPreferences.date_night,
  });
}

async function executeComposioAction(toolInput, composioUserId) {
  if (!composio) {
    return JSON.stringify({ error: 'Composio is not configured' });
  }
  const slug = toolInput?.tool_slug || toolInput?.toolSlug;
  if (!slug) {
    return JSON.stringify({ error: 'Missing tool_slug' });
  }
  const slugStr = String(slug);
  if (/\bCALENDAR\b|GCAL|OUTLOOK_?CAL|MICROSOFT_?CAL|FREE_?BUSY|BUSY_?READ|MEETING_?TIME|_EVENTS?\b|CREATE_?EVENT|LIST_?EVENT/i.test(slugStr)) {
    return JSON.stringify({
      error:
        'Calendar and scheduling use execute_pipedream_calendar_task (not Composio). This tool is blocked for calendar-related slugs.',
    });
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
 * Fetches active Composio connections for the user and builds a Toolbox (metadata + Anthropic tool defs).
 * @param {string} userId - Postgres user UUID; used as Composio entityId / user_id everywhere.
 * @param {{ subscriptionStatus?: 'PRO'|'LITE' }} [options] - execute_action is only exposed when subscriptionStatus is PRO.
 */
async function getAgentTools(userId, options = {}) {
  const uid = String(userId);
  const subscriptionStatus = options.subscriptionStatus === 'PRO' ? 'PRO' : 'LITE';
  const archProfileTools = getArchitectureProfileAnthropicTools();
  const pipedreamCalendarTools = getPipedreamCalendarAnthropicTools();
  const calendarAvailabilityTools = getCalendarAvailabilityAnthropicTools();
  const staticAnthropicTools = [
    ...archProfileTools,
    ...calendarAvailabilityTools,
    ...pipedreamCalendarTools,
    SAVE_ONBOARDING_PROFILE_ANTHROPIC_TOOL,
    SAVE_DATE_NIGHT_PREFERENCES_ANTHROPIC_TOOL,
  ];

  if (!composio || options.skipComposio) {
    return {
      connections: [],
      availableTools: [],
      anthropicTools: staticAnthropicTools,
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
    const anthropicTools = [...staticAnthropicTools];
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
    if (!options.skipComposio) {
      console.error('getAgentTools error:', err.message);
    }
    return {
      connections: [],
      availableTools: [],
      anthropicTools: staticAnthropicTools,
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

/** Airtable field names — set AIRTABLE_*_FIELD in Railway to match your base exactly. */
function buildAirtableRecordFields({ client_id, phone_number, email, tier, last_message }) {
  const phoneColumn = getAirtablePhoneFieldName();
  const emailField = getAirtableEnvPick('AIRTABLE_EMAIL_FIELD', 'Email');
  const tierField = getAirtableEnvPick('AIRTABLE_TIER_FIELD', 'Tier');
  const lastMsgField = getAirtableEnvPick('AIRTABLE_LAST_MESSAGE_FIELD', 'Last Message');

  return {
    'Client ID': client_id ?? '',
    [phoneColumn]: resolveCleanPhoneForAirtable(phone_number, null) || (phone_number ?? ''),
    [emailField]: email ?? '',
    [tierField]: tier ?? '',
    [lastMsgField]: last_message ?? '',
  };
}

async function syncToAirtable({ client_id, phone_number, email, tier, last_message }) {
  const cleanPhone = resolveCleanPhoneForAirtable(phone_number, null);
  const fields = buildAirtableRecordFields({ client_id, phone_number, email, tier, last_message });
  await upsertAirtableRecord(fields, {
    clientId: client_id,
    cleanPhone,
    logTag: 'AIRTABLE_SYNC',
  });
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
    'SELECT id, first_name, last_name, phone_number, email, client_id, short_id, tier, last_nudge_at, created_at, trial_start_date, subscription_status, google_super_connected, calendar_provider, architecture_synced_at, onboarding_status, onboarding_phase, active_automations, preferences FROM users WHERE phone_number = $1',
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
     RETURNING id, first_name, last_name, phone_number, email, client_id, short_id, tier, last_nudge_at, created_at, trial_start_date, subscription_status, google_super_connected, calendar_provider, architecture_synced_at, onboarding_status, onboarding_phase, active_automations, preferences`,
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
  const system = (baseSystemPrompt || buildEliteTriageSystemPrompt()) + composioSupplement;
  const hasAnthropicTools = Boolean(toolbox?.anthropicTools?.length);

  // --- TRY CLAUDE FIRST ---
  try {
    if (hasAnthropicTools) {
      const conv = messages.map((m) => ({ role: m.role, content: m.content }));
      for (let step = 0; step < 6; step += 1) {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          system,
          tools: toolbox.anthropicTools,
          messages: conv,
        });
        const blocks = msg.content || [];
        const toolUses = blocks.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) {
          const tb = blocks.find((b) => b.type === 'text');
          return tb ? tb.text : '';
        }
        conv.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const tu of toolUses) {
          let payload;
          if (tu.name === 'fetch_architecture_profile') {
            payload = await fetchArchitectureProfile(tu.input?.client_id);
          } else if (tu.name === 'check_calendar_availability') {
            payload = await checkCalendarAvailability(composioUserId, tu.input);
          } else if (tu.name === 'execute_pipedream_calendar_task') {
            payload = await executePipedreamCalendarTask(tu.input);
          } else if (tu.name === 'execute_action') {
            payload = await executeComposioAction(tu.input, composioUserId);
          } else if (tu.name === 'save_onboarding_profile') {
            payload = await saveOnboardingProfile(composioUserId, tu.input, options.senderPhoneNumber);
          } else if (tu.name === 'save_date_night_preferences') {
            payload = await saveDateNightPreferences(composioUserId, tu.input);
          } else {
            payload = JSON.stringify({ error: `Unknown tool: ${tu.name}` });
          }
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: payload,
          });
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
      const result = await tavilyClient.search(tavilyQuery, {
        maxResults: 5,
        includeAnswer: false,
        includeImages: false,
      });
      web = Array.isArray(result?.results) ? result.results : [];
    } catch (err) {
      console.error('[Tavily] search failed (non-fatal):', err?.message || err);
      web = [];
    }
  }

  return { vault, web, vaultLowConfidence: vaultResult.lowConfidence, vaultBestRank: vaultResult.bestRank };
}

async function runAgenticConcierge(user, userMessage, options = {}) {
  const msgText = String(normalizeSearchQueryText(userMessage) ?? '').trim();
  const subscriptionStatus = getSubscriptionStatusFromUser(user);
  const onboardingPending = isOnboardingPending(user);
  const toolbox = await getAgentTools(user.id, {
    subscriptionStatus,
    skipComposio: onboardingPending,
  });
  const history = await getChatHistory(user.id);
  const displayName = user.first_name || 'Client';

  const trialStart = user.trial_start_date ?? user.created_at;
  const trialDay = calculateTrialDay(trialStart);
  const connectionReport = buildConnectionStatusReport(toolbox.connections);

  const enrollAnchor = user.trial_start_date ?? user.created_at;
  let daysSinceEnrollment = 'N/A';
  let foundingMember180Window = false;
  if (enrollAnchor) {
    const en = new Date(enrollAnchor);
    if (!Number.isNaN(en.getTime())) {
      const d = Math.floor((Date.now() - en.getTime()) / (1000 * 60 * 60 * 24));
      daysSinceEnrollment = String(d);
      foundingMember180Window = d >= 0 && d <= 180;
    }
  }

  const calendarOnboardingLink = await generateOnboardingLink(user.id);

  const calendarProviderNorm = normalizeCalendarProviderValue(user.calendar_provider);
  const isConnected = calendarProviderNorm === 'google' || calendarProviderNorm === 'outlook';
  const archAt =
    user.architecture_synced_at != null
      ? new Date(user.architecture_synced_at).toISOString()
      : 'N/A';
  const onboardingStatus =
    user.onboarding_status != null && String(user.onboarding_status).trim() !== ''
      ? String(user.onboarding_status).trim()
      : 'pending';
  const onboardingPhase =
    user.onboarding_phase != null && Number.isFinite(Number(user.onboarding_phase))
      ? Number(user.onboarding_phase)
      : 1;
  const activeAutomationsList = normalizeAutomationSlugs(parseUserJsonbArray(user.active_automations));
  const userPreferences = parseUserJsonbObject(user.preferences);
  const profilePrefs = userPreferences.profile || {};
  const dateNightIntakeRequired = needsDateNightIntake(user);
  const automationIntakePending = buildAutomationIntakePending(user);

  const dynamicContext = `
### LIVE USER CONTEXT
- user_id: ${user.id}
- client_id: ${(() => {
    const onboardingId = user.short_id || user.client_id;
    return onboardingId != null && String(onboardingId).trim() !== '' ? onboardingId : 'N/A';
  })()}
- Email: ${user.email != null && String(user.email).trim() !== '' ? user.email : 'N/A'}
- First Name: ${user.first_name != null && String(user.first_name).trim() !== '' ? user.first_name : 'N/A'}
- Last Name: ${user.last_name != null && String(user.last_name).trim() !== '' ? user.last_name : 'N/A'}
- Onboarding Status: ${onboardingStatus}
- onboarding_phase: ${onboardingPhase}
- Occupation: ${profilePrefs.occupation || 'N/A'}
- Friction Points: ${profilePrefs.friction_points || 'N/A'}
- Service Commitment: ${profilePrefs.service_commitment || 'N/A'}
- Active Automations: ${formatAutomationSlugList(activeAutomationsList)}
- automation_intake_pending: ${automationIntakePending}
- Preferences: ${JSON.stringify(userPreferences)}
- date_night_intake_required: ${dateNightIntakeRequired}
- Calendar Provider: ${calendarProviderNorm || 'None'}
- Calendar Connected: ${isConnected ? 'True' : 'False'}
- display_name: ${user.first_name || 'Client'}
- trial_start_date: ${trialStart ? new Date(trialStart).toISOString() : 'N/A'}
- current_day_of_trial: ${trialDay != null ? trialDay : 'N/A'}
- days_since_enrollment: ${daysSinceEnrollment}
- founding_member_180_window: ${foundingMember180Window}
- subscription_status: ${subscriptionStatus}
- autonomous_execution_enabled: ${subscriptionStatus === 'PRO' || foundingMember180Window}
- connection_status: ${JSON.stringify(connectionReport)}
- calendar_onboarding_link: ${calendarOnboardingLink}
- architecture_synced_at: ${archAt}
`;
  const lockedOverrideBlock = !isConnected
    ? `
### VAULT CONNECTION
- Calendar is not connected. Use calendar_onboarding_link from LIVE USER CONTEXT — do not use tools for OAuth.
`
    : '';
  const dateNightBlock = dateNightIntakeRequired
    ? `
### REQUIRED ACTION: DATE NIGHT INTAKE
date_night_intake_required is true. Run the date_night intake protocol from FLAGSHIP AUTOMATION FRAMEWORK, then call save_date_night_preferences.
`
    : '';
  const automationIntakeBlock =
    automationIntakePending !== 'none' && !dateNightIntakeRequired
      ? `
### REQUIRED ACTION: AUTOMATION INTAKE
automation_intake_pending: ${automationIntakePending}
Run the matching FLAGSHIP AUTOMATION FRAMEWORK intake protocol before proposing execution.
`
      : '';
  const calendarToolBlock = isConnected
    ? `
### CALENDAR TOOLS ACTIVE
Calendar Connected is True. You MUST call check_calendar_availability before proposing any specific date or time window.
`
    : '';
  const finalSystemPrompt = `${buildEliteTriageSystemPrompt()}\n\n${dynamicContext}${lockedOverrideBlock}${calendarToolBlock}${dateNightBlock}${automationIntakeBlock}`;

  const { vault, web, vaultLowConfidence, vaultBestRank } = await search_vault_and_web(msgText, {
    skipTavily: onboardingPending,
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

  return await getHybridResponseFromMessages(messages, msgText, toolbox, user.id, finalSystemPrompt, options);
}

async function getClaudeResponse(userTier, userMessage) {
  const tierInstruction = userTier === 'pro'
    ? "USER_TIER is 'pro'. Follow the pro response rule."
    : "USER_TIER is 'lite'. Follow the lite response rule (recommendation + link, then upsell).";

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: buildEliteTriageSystemPrompt(),
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

/**
 * Handshake verification: WhatsApp message must match exactly after web onboarding.
 * In your Pipedream HTTP step (calling external APIs), you may use headers such as:
 *   Authorization: `Bearer ${accessToken}`
 *   Content-Type: application/json
 *   x-pd-environment: development  // use "production" when you launch
 */
/** Exact post-onboarding line: triggers server-side profile sync + obligates Alice to call fetch_architecture_profile in-thread when needed. */
const SYSTEMS_SYNC_HANDSHAKE_PHRASE =
  "I've now connected my calendar and enabled my automations - please sync systems to activate.";

const HANDSHAKE_VERIFICATION_INCOMING_MESSAGE =
  'Handshake complete. I have successfully connected my calendar.';

const HANDSHAKE_VERIFIED_ALICE_RESPONSE = `Handshake verified. 🛡️ Your secure Vault is now open. I have unlocked your first 3 Elite Services:
1. Priority Schedule Triage
2. Conflict Resolver
3. Lifestyle Briefings.

Shall we start by reviewing your upcoming week, or would you like to configure your Advanced Automations next?`;

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

  // Reject forged requests: validate Twilio's X-Twilio-Signature against the public webhook URL.
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    const twilioSignature = req.headers['x-twilio-signature'];
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const webhookUrl = `${base}/webhook`;
    const valid =
      Boolean(base) &&
      Boolean(twilioSignature) &&
      twilio.validateRequest(authToken, twilioSignature, webhookUrl, req.body || {});
    if (!valid) {
      console.warn('[SECURITY] Rejected /webhook with invalid Twilio signature from', req.body?.From);
      res.status(403).send('Invalid signature');
      return;
    }
  } else {
    console.warn('[SECURITY] TWILIO_AUTH_TOKEN not set; skipping Twilio signature validation');
  }

  try {
    // 1. Database Check
    console.log('Status: Checking Database...');
    const phoneNumber = req.body.From;
    const profileName = req.body.ProfileName || req.body.profileName || null;

    let user = await getUserByPhone(phoneNumber);
    let isNewUser = false;

    if (!user) {
      console.log('Status: New user detected. Creating Explorer profile...');
      user = await createNewUser(phoneNumber, profileName);
      isNewUser = true;
    } else if (!user.first_name && profileName) {
      await pool.query('UPDATE users SET first_name = $1 WHERE id = $2', [profileName, user.id]);
      user.first_name = profileName;
    }

    if (!user.client_id) {
      const cid = await ensureClientIdForUser(user.id);
      if (cid) user.client_id = cid;
    }
    if (!user.short_id) {
      const sid = await ensureShortIdForUser(user.id);
      if (sid) user.short_id = sid;
    }
    if (!user.phone_number && phoneNumber) {
      user.phone_number = phoneNumber;
    }
    console.log('Status: User identified as:', user.tier);

    // Anchor Client ID + phone in Airtable on every message (idempotent)
    const airtableLeadOk = await seedAirtableLeadRecord(user, phoneNumber);
    if (!airtableLeadOk) {
      console.warn('[AIRTABLE_LEAD] sync skipped or failed');
    }

    const incomingText = String(req.body.Body || '').trim();

    if (/\b(reset|start over).*(onboarding|flow)\b/i.test(incomingText)) {
      await resetOnboardingState(user.id);
      const refreshed = await getUserByPhone(phoneNumber);
      if (refreshed) user = refreshed;
    }

    // Systems-sync phrase: pull CalendarProvider from Airtable → Postgres, merge split rows
    if (incomingText === SYSTEMS_SYNC_HANDSHAKE_PHRASE) {
      const onboardingId = user.short_id || user.client_id;
      if (onboardingId) {
        const airtableSync = await syncCalendarFromAirtableForUser(user.id, onboardingId);

        const raw = await fetchArchitectureProfile(onboardingId);
        const persisted = await persistArchitectureSessionFromPipedreamResponse(user.id, raw, {
          preserveAutomations: isOnboardingPending(user),
        });

        if (!airtableSync?.calendarProvider && persisted?.calendarProvider) {
          await pool.query(
            `UPDATE users SET calendar_provider = $1, architecture_synced_at = NOW() WHERE id = $2`,
            [persisted.calendarProvider, user.id]
          );
        }

        if (persisted?.activeAutomations != null && !isOnboardingPending(user)) {
          user.active_automations = persisted.activeAutomations;
        }

        await pool.query(
          `UPDATE users SET onboarding_phase = GREATEST(COALESCE(onboarding_phase, 1), 6) WHERE id = $1`,
          [user.id]
        );

        await seedAirtableLeadRecord(user, phoneNumber);

        const refreshed = await getUserByPhone(phoneNumber);
        if (refreshed) user = refreshed;

        console.log('[SYNC] Systems-sync handshake processed for user:', user.id, {
          calendar_provider: user.calendar_provider,
          airtableDuplicates: airtableSync?.duplicateCount || 0,
          preservedWhatsAppAutomations: isOnboardingPending(user),
        });
      } else {
        console.warn('[SYNC] Systems-sync phrase but missing short_id/client_id');
      }
    }

    // Handshake verification (exact message — skips normal agent flow)
    if (incomingText === HANDSHAKE_VERIFICATION_INCOMING_MESSAGE) {
      const shortId = await ensureShortIdForUser(user.id);
      if (shortId) user.short_id = shortId;
      console.log(`[VERIFICATION] Handshake detected for: ${phoneNumber}`);
      if (shortId) {
        await syncCalendarFromAirtableForUser(user.id, shortId);
        await seedAirtableLeadRecord(user, phoneNumber);
        const refreshed = await getUserByPhone(phoneNumber);
        if (refreshed) user = refreshed;
      } else {
        console.error('[VERIFICATION] short_id could not be assigned');
      }
      await saveConversation(user.id, incomingText, HANDSHAKE_VERIFIED_ALICE_RESPONSE, {
        trigger: 'handshake_verification',
      });
      res.type('text/xml');
      res.send(twimlMessage(HANDSHAKE_VERIFIED_ALICE_RESPONSE));
      console.log('--- WEBHOOK COMPLETE (handshake verification) ---');
      return;
    }

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
    console.log('[FLOW] Running Agentic Concierge...');
    console.log('[CRITICAL] Waiting for AI response...');
    const aiText = await runAgenticConcierge(user, incomingText, {
      senderPhoneNumber: phoneNumber || user.phone_number,
    });
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

// Safety net: log instead of crashing on any stray unhandled promise rejection.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason instanceof Error ? reason.message : reason);
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
