require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
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
        await pool.query('UPDATE users SET tier = $1 WHERE id = $2', ['pro', user.id]);
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
const googleAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

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

Constraint: Elite, professional tone. Economical but powerful language. No emojis.
`;

const NEW_LEAD_ALERT_EMAIL = 'assist@ailifeconcierge.co.uk';
const REQUEST_SUMMARY_EMAIL = 'assist@ailifeconcierge.co.uk';

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

async function syncToAirtable({ client_id, phone_number, email, tier, last_message }) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  if (!apiKey || !baseId || !tableName) return;

  try {
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
    const payload = {
      records: [
        {
          fields: {
            client_id,
            phone_number,
            email,
            tier,
            last_message,
          },
        },
      ],
    };

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
      console.error('Airtable sync failed:', resp.status, text);
    }
  } catch (err) {
    console.error('Airtable sync error:', err.message);
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

async function getUserByPhone(phoneNumber) {
  const result = await pool.query(
    'SELECT id, first_name, last_name, phone_number, email, client_id, tier, last_nudge_at, created_at FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  return result.rows[0] || null;
}

async function createNewUser(phoneNumber, profileName) {
  const result = await pool.query(
    `INSERT INTO users (phone_number, first_name, tier, client_id)
     VALUES ($1, $2, 'lite', $3)
     RETURNING id, first_name, last_name, phone_number, email, client_id, tier, last_nudge_at, created_at`,
    [phoneNumber, profileName || 'Explorer', generateClientId()]
  );
  return result.rows[0];
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

async function getHybridResponseFromMessages(messages, userMessage) {
  // --- TRY CLAUDE FIRST ---
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: ELITE_TRIAGE_SYSTEM_PROMPT,
      messages,
    });
    return msg.content[0].text;
  } catch (claudeErr) {
    console.error('Claude Failed. Error:', claudeErr.message);

    // --- FAIL-SAFE: GEMINI ---
    try {
      const geminiModel = googleAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const geminiHistory = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const chat = geminiModel.startChat({
        history: geminiHistory.slice(0, -1),
        systemInstruction: ELITE_TRIAGE_SYSTEM_PROMPT,
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
  const raw = String(query || '').trim();
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

// Tool: search Postgres vault first, live web second.
async function search_vault_and_web(query) {
  const vaultResult = await searchRecommendations(query);
  const vault = vaultResult.rows;
  let web = [];

  if (tavilyClient) {
    try {
      const result = await tavilyClient.search({
        query: String(query || ''),
        max_results: 5,
        include_answer: false,
        include_images: false,
      });
      web = Array.isArray(result?.results) ? result.results : [];
    } catch (err) {
      console.error('Tavily search failed:', err.message);
    }
  }

  return { vault, web, vaultLowConfidence: vaultResult.lowConfidence, vaultBestRank: vaultResult.bestRank };
}

async function runAgenticConcierge(user, userMessage) {
  const history = await getChatHistory(user.id);
  const userContext = `User: ${user.first_name || 'Client'}. Current Tier: ${user.tier}.`;

  const { vault, web, vaultLowConfidence, vaultBestRank } = await search_vault_and_web(userMessage);

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
    { role: 'user', content: `[CONTEXT: ${userContext}]` },
    { role: 'user', content: `[TOOL: search_vault_and_web]\n${toolContext}` },
    ...history,
    { role: 'user', content: userMessage },
  ];

  return await getHybridResponseFromMessages(messages, userMessage);
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

    // 2. PII-stripped Airtable sync
    await syncToAirtable({
      client_id: user.client_id,
      phone_number: user.phone_number,
      email: user.email || null,
      tier: user.tier,
      last_message: incomingText,
    });

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

    // 3. Agentic Concierge for standard messages
    console.log('Status: Running Agentic Concierge...');
    const aiResponse = await runAgenticConcierge(user, incomingText);

    // 4. Pro tier handling: notify Human Architect to authenticate execution
    if (user.tier === 'pro') {
      await sendEmail({
        to: 'assist@ailifeconcierge.co.uk',
        subject: `PRO TASK: ${phoneNumber}`,
        text: `Pro task received.\n\nFrom: ${phoneNumber}\nProfileName: ${profileName || ''}\nClientID: ${user.client_id || ''}\nMessage: ${incomingText}\n\nAI response:\n${aiResponse}\n\nTimestamp: ${new Date().toISOString()}`,
      });
    }

    // SAVE TO MEMORY
    await saveConversation(user.id, incomingText, aiResponse);

    // 3. Twilio Response
    console.log('Status: Sending TwiML back to Twilio...');
    res.type('text/xml');
    res.send(twimlMessage(aiResponse));
    console.log('--- WEBHOOK COMPLETE ---');
  } catch (err) {
    console.error('!!! ERROR IN WEBHOOK !!!');
    console.error(err.message);
    res.status(500).send('Error');
  }
});

app.get('/portal', (req, res) => {
  const waUrl =
    'https://wa.me/441483694296?text=Vault%20access%20staged.%20I%20am%20ready%20to%20begin%20my%20Sovereign%20Audit%20with%20the%20Architect.';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Golden Vault — Ai Life Concierge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      background: #000000;
      color: #D4AF37;
      font-family: "Instrument Serif", Georgia, "Times New Roman", serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      padding: 1.5rem;
      -webkit-tap-highlight-color: transparent;
    }
    .vault {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      width: 100%;
      max-width: 28rem;
    }
    .key-wrap {
      cursor: pointer;
      transform-origin: 50% 50%;
      transition: transform 0.5s ease;
      animation: vaultPulse 2.4s ease-in-out infinite;
    }
    .key-wrap:active { filter: brightness(1.08); }
    .key-wrap.unlocked {
      animation: none;
      transform: rotate(90deg);
    }
    @keyframes vaultPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    .key-wrap svg { display: block; width: min(72vw, 280px); height: auto; filter: drop-shadow(0 0 24px rgba(212, 175, 55, 0.35)); }
    .headline {
      margin-top: 2.25rem;
      text-align: center;
      font-size: clamp(0.7rem, 2.8vw, 0.85rem);
      font-weight: 400;
      letter-spacing: 1.5px;
      line-height: 1.65;
      text-transform: uppercase;
      max-width: 22rem;
      opacity: 1;
      transition: opacity 0.45s ease;
    }
    .headline.fade-out { opacity: 0; }
    .headline.granted { color: #FFD700; }
  </style>
</head>
<body>
  <div class="vault">
    <div class="key-wrap" id="vaultKey" role="button" tabindex="0" aria-label="Unlock vault">
      <svg viewBox="0 0 200 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="gGold" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#FFF8DC"/>
            <stop offset="22%" style="stop-color:#D4AF37"/>
            <stop offset="45%" style="stop-color:#FFD700"/>
            <stop offset="62%" style="stop-color:#B8860B"/>
            <stop offset="100%" style="stop-color:#8B6914"/>
          </linearGradient>
          <linearGradient id="gGoldDark" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#5C4813"/>
            <stop offset="50%" style="stop-color:#C9A227"/>
            <stop offset="100%" style="stop-color:#F0E68C"/>
          </linearGradient>
          <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <g filter="url(#softGlow)">
          <path fill="url(#gGold)" stroke="#8B6914" stroke-width="0.8" d="M100 18c-28 0-50 22-50 50 0 18 9 34 23 43l-2 118c0 8 6 14 14 14h30c8 0 14-6 14-14l-2-118c14-9 23-25 23-43 0-28-22-50-50-50zm0 12c21 0 38 17 38 38 0 14-7 26-18 33l-1 124h-38l-1-124c-11-7-18-19-18-33 0-21 17-38 38-38z"/>
          <ellipse cx="100" cy="68" rx="34" ry="34" fill="none" stroke="url(#gGoldDark)" stroke-width="2.5" opacity="0.85"/>
          <path fill="url(#gGoldDark)" d="M100 42c-14 0-26 12-26 26s12 26 26 26 26-12 26-26-12-26-26-26zm0 10c9 0 16 7 16 16s-7 16-16 16-16-7-16-16 7-16 16-16z"/>
          <rect x="94" y="128" width="12" height="118" rx="2" fill="url(#gGold)" stroke="#6B5310" stroke-width="0.6"/>
          <path fill="url(#gGold)" stroke="#6B5310" stroke-width="0.6" d="M106 200h38v14h-12v18h12v14h-38v-46z"/>
          <path fill="url(#gGoldDark)" opacity="0.35" d="M98 132h4v110h-4z"/>
          <circle cx="72" cy="62" r="5" fill="#2a2208" stroke="#D4AF37" stroke-width="0.5"/>
          <circle cx="128" cy="62" r="5" fill="#2a2208" stroke="#D4AF37" stroke-width="0.5"/>
          <path fill="none" stroke="#B8860B" stroke-width="1" opacity="0.6" d="M100 24v88 M70 68h60"/>
        </g>
      </svg>
    </div>
    <p class="headline" id="vaultHeadline">RECLAIM YOUR FIRST 10 HOURS. UNLOCK NOW.</p>
  </div>
  <script>
    (function () {
      var key = document.getElementById('vaultKey');
      var headline = document.getElementById('vaultHeadline');
      var done = false;
      var wa = ${JSON.stringify(waUrl)};
      function unlock() {
        if (done) return;
        done = true;
        try { if (navigator.vibrate) navigator.vibrate([40, 60]); } catch (e) {}
        key.classList.add('unlocked');
        headline.classList.add('fade-out');
        setTimeout(function () {
          headline.textContent = 'ACCESS GRANTED. REDIRECTING...';
          headline.classList.add('granted');
          headline.classList.remove('fade-out');
        }, 420);
        setTimeout(function () { window.location.href = wa; }, 900);
      }
      key.addEventListener('click', unlock);
      key.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unlock(); }
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
