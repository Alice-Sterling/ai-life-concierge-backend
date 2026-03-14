require('dotenv').config();
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
    model: 'claude-3-5-sonnet-20241022',
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
  const phoneNumber = req.body?.From || req.body?.from;
  const messageBody = (req.body?.Body || req.body?.body || '').trim();

  if (!phoneNumber || !messageBody) {
    res.type('text/xml').status(400).send(twimlMessage('Please send a message with content.'));
    return;
  }

  let user;
  let isNewUser = false;

  try {
    user = await getUserByPhone(phoneNumber);

    if (!user) {
      user = await createNewUser(phoneNumber);
      isNewUser = true;

      await sendEmail({
        to: NEW_LEAD_ALERT_EMAIL,
        subject: '[ALC] New lead – Explorer signed up',
        text: `New lead created from WhatsApp.\n\nPhone: ${phoneNumber}\nFirst message: ${messageBody}\nCreated at: ${new Date().toISOString()}`,
      });
    }

    const tier = user.tier || 'lite';
    const aiResponse = await getClaudeResponse(tier, messageBody);

    await saveConversation(user.id, messageBody, aiResponse, {
      from: phoneNumber,
      tier,
      isNewUser,
    });

    await sendEmail({
      to: REQUEST_SUMMARY_EMAIL,
      subject: `[ALC] Request summary – ${phoneNumber}`,
      text: `Phone: ${phoneNumber}\nTier: ${tier}\nMessage: ${messageBody}\n\nAI response:\n${aiResponse}\n\nTimestamp: ${new Date().toISOString()}`,
    });

    res.type('text/xml').send(twimlMessage(aiResponse));
  } catch (err) {
    console.error('Webhook error:', err);
    res.type('text/xml').status(500).send(twimlMessage('We encountered an issue. Our team has been notified.'));
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-life-concierge' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
