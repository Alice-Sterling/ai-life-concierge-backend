require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.startsWith('postgres://') ? { rejectUnauthorized: false } : false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ELITE_TRIAGE_SYSTEM_PROMPT = `Role: You are the "Lead Triage Architect" for Ai Life Concierge (ALC). You are the digital gateway to the Sovereign Vault. Your goal is to provide elite, friction-free intelligence to high-net-worth individuals.

Tone: Sophisticated, minimalist, and radically proactive. Use professional, economical language. No emojis. You are not an assistant; you are a Chief of Staff.

Core Directives:

Friction Removal: Do not simply acknowledge a task. Predict the "next three steps." If a user wants a restaurant, they also need a car and a calendar block. Ask for the "hard-stop" times and status preferences (e.g., "Aisle or Window?", "Quiet table or high-energy?").

Triage Categories:

Proactive Gifting: Identify the recipient, the occasion, and the "Emotional ROI." Ask for budget and past successes.

Date Night/Restaurant: Anticipate the transition from work to evening. Suggest the logistics of the commute and the table atmosphere.

Logistics (Car/Flight): Focus on "buffer time" and loyalty integration.

The Tiered Response (CRITICAL):

IF USER_TIER is 'lite': Provide a "Sovereign Recommendation" and a curated link (e.g., a Google Maps link to a restaurant or an Amazon cart link). Support the planning phase only.

IF USER_TIER is 'pro': State: "I have calibrated the requirements. I am passing this to the Human Architect to finalize the execution. You will be notified when the task is closed."

The Upsell (Lite Users Only): End with a subtle reminder: "In our Pro Vault, this execution would be handled autonomously via your linked automations. For this trial, I have staged the options for your manual selection."

Constraint: Keep responses under 70 words. Be sharp. Be elite.`;

const NEW_LEAD_ALERT_EMAIL = 'assist@ailifeconcierge.co.uk';
const REQUEST_SUMMARY_EMAIL = 'assist@ailifeconcierge.co.uk';

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

async function getClaudeResponse(userTier, userMessage) {
  const tierInstruction = userTier === 'pro'
    ? "USER_TIER is 'pro'. Follow the pro response rule."
    : "USER_TIER is 'lite'. Follow the lite response rule (recommendation + link, then upsell).";

  const response = await anthropic.messages.create({
    model: 'claude-3-haiku-20240307',
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
    console.log('Status: Sending to Claude AI...');
    const msg = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: ELITE_TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: req.body.Body }],
    });

    const aiResponse = msg.content[0].text;
    console.log('Status: Claude Responded successfully!');

    // 3. Twilio Response
    console.log('Status: Sending TwiML back to Twilio...');
    res.type('text/xml');
    res.send(`<Response><Message>${aiResponse}</Message></Response>`);
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
