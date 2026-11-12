/**
 * Conversation history manager for Alice.
 *
 * It converts persisted conversation rows into a bounded Claude transcript:
 * filtered for protocol noise, timestamped, and reduced to a recent sliding
 * window plus a deterministic older-context summary.
 */

const { pool } = require('../db/pool');
const { cleanPromptText, compactOneLine, isoOrNA } = require('./promptBuilder');

const DEFAULT_NOISE_PHRASES = [
  "I've now connected my calendar and enabled my automations - please sync systems to activate.",
  'Handshake complete. I have successfully connected my calendar.',
];

function isHistoryNoise(row, { noisePhrases = DEFAULT_NOISE_PHRASES } = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const message = String(row?.message_body || '').trim();
  return Boolean(
    meta.queued_for_human ||
      meta.ping_reply ||
      meta.trigger === 'handshake_verification' ||
      noisePhrases.includes(message)
  );
}

function formatHistoryLine(timestamp, speaker, text, maxLen = 900) {
  return `[${isoOrNA(timestamp)}] ${speaker}: ${cleanPromptText(text, maxLen)}`;
}

function buildHistoryContext(rows, {
  windowMessages = 8,
  summaryMessages = 8,
  noisePhrases = DEFAULT_NOISE_PHRASES,
} = {}) {
  const turns = [];
  [...(rows || [])].reverse().forEach((row) => {
    if (isHistoryNoise(row, { noisePhrases })) return;
    if (row?.message_body) {
      turns.push({
        role: 'user',
        content: formatHistoryLine(row.timestamp, 'Client', row.message_body),
        timestamp: row.timestamp,
      });
    }
    if (row?.ai_response) {
      turns.push({
        role: 'assistant',
        content: formatHistoryLine(row.timestamp, 'Alice', row.ai_response),
        timestamp: row.timestamp,
      });
    }
  });

  // The Messages API wants the transcript to open with a client turn. A row
  // with a reply but no inbound text (a media-only message) can leave the
  // window starting on Alice, so leading Alice turns move to the summary.
  const windowTurns = turns.slice(-windowMessages);
  while (windowTurns.length && windowTurns[0].role !== 'user') windowTurns.shift();
  const recent = windowTurns.map(({ role, content }) => ({ role, content }));
  const older = turns.slice(0, Math.max(0, turns.length - recent.length));
  const summary = older.length
    ? older
        .slice(-summaryMessages)
        .map((t) => {
          const d = isoOrNA(t.timestamp).slice(0, 10);
          const who = t.role === 'assistant' ? 'Alice' : 'Client';
          const text = t.content.replace(/^\[[^\]]+\]\s*(Client|Alice):\s*/, '');
          return `- ${d} ${who}: ${compactOneLine(text, 180)}`;
        })
        .join('\n')
    : '';

  return { messages: recent, summary };
}

/**
 * History lines carry a "[timestamp] Alice:" label. A model that sees its own
 * past turns written that way can copy the label into a new reply; this takes
 * it off again so it never reaches WhatsApp.
 */
const TRANSCRIPT_PREFIX_RE = /^\s*(?:\[\d{4}-\d{2}-\d{2}T[^\]\n]{0,40}\]\s*(?:Alice\s*:\s*)?)+/i;

function stripTranscriptPrefix(reply) {
  if (typeof reply !== 'string') return reply;
  return reply.replace(TRANSCRIPT_PREFIX_RE, '');
}

async function getChatHistory(userId, {
  fetchLimit = 24,
  windowMessages = 8,
  summaryMessages = 8,
  noisePhrases = DEFAULT_NOISE_PHRASES,
} = {}) {
  const result = await pool.query(
    `SELECT message_body, ai_response, metadata, timestamp
       FROM conversations
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT $2`,
    [userId, fetchLimit]
  );
  return buildHistoryContext(result.rows, { windowMessages, summaryMessages, noisePhrases });
}

module.exports = {
  DEFAULT_NOISE_PHRASES,
  isHistoryNoise,
  formatHistoryLine,
  buildHistoryContext,
  stripTranscriptPrefix,
  getChatHistory,
};
