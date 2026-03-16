require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.startsWith('postgres://') ? { rejectUnauthorized: false } : false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const googleAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

const STRIPE_LINK = 'https://buy.stripe.com/7sY7sLdQYbuqaHRbzRc7u00';

const ELITE_TRIAGE_SYSTEM_PROMPT = `
Role: Lead Triage Architect for Ai Life Concierge (ALC).
Persona: Elite Chief of Staff. Sophisticated, proactive, value-driven.

Priority order for every response:
1. DELIGHT FIRST: Deliver a curated solution with a clear WHY, plus a booking/calendar link where relevant. Make the client feel understood and served immediately.
2. STRATEGIC NUDGE: Explain how the Pro Vault would have predicted this need and handled it autonomously (calendar + apps + human oversight). Contrast with their current manual step.
3. OFFER TRIAL: Mention that Pro members recover 10+ hours per week and that every action is overseen by a Human Lifestyle Architect. Invite them to start the 30-day Sovereign trial: ${STRIPE_LINK}

Constraint: Elite, professional tone. Economical but powerful language. No emojis.
`;

const NEW_LEAD_ALERT_EMAIL = 'assist@ailifeconcierge.co.uk';
const REQUEST_SUMMARY_EMAIL = 'assist@ailifeconcierge.co.uk';

// 24-hour automation nudge: hourly check for lite users whose last message was 20–23h ago
const SOVEREIGN_NUDGE_MESSAGE = `Architect here. You’ve had a moment to experience the Lite tier. Pro Vault members recover 10+ hours per week—every booking and follow-up is overseen by a Human Lifestyle Architect. Start your 30-day Sovereign trial: ${STRIPE_LINK}`;

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
    'SELECT id, first_name, last_name, phone_number, email, client_id, tier, created_at FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  return result.rows[0] || null;
}

async function createNewUser(phoneNumber) {
  const result = await pool.query(
    `INSERT INTO users (phone_number, first_name, tier) VALUES ($1, $2, 'lite') RETURNING id, first_name, last_name, phone_number, email, client_id, tier, created_at`,
    [phoneNumber, 'Explorer']
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

async function getHybridResponse(user, userMessage) {
  const history = await getChatHistory(user.id);

  const userContext = `User: ${user.first_name || 'Client'}. Current Tier: ${user.tier}.`;

  const messages = [
    { role: 'user', content: `[CONTEXT: ${userContext}]` },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // --- TRY CLAUDE FIRST ---
  try {
    console.log('Status: Attempting Claude Sonnet 4.6...');
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
      console.log('Status: Switching to Gemini Fail-Safe...');
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
    let user = await getUserByPhone(req.body.From);

    if (!user) {
      console.log('Status: New user detected. Creating Explorer profile...');
      user = await createNewUser(req.body.From);
    }
    console.log('Status: User identified as:', user.tier);

    // 2. AI Request
    console.log('Status: Sending to Hybrid AI...');
    const aiResponse = await getHybridResponse(user, req.body.Body);

    // SAVE TO MEMORY
    await saveConversation(user.id, req.body.Body, aiResponse);

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
