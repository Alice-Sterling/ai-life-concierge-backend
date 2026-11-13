/**
 * Voice notes -> text (Project 4, Scenario D).
 *
 * WhatsApp voice notes reach the webhook as a media URL on Twilio. This
 * downloads the audio and sends it to a Whisper endpoint. Groq and OpenAI
 * expose the same API shape, so one function serves both:
 *
 *   GROQ_API_KEY    -> Groq   (whisper-large-v3-turbo), used when set
 *   OPENAI_API_KEY  -> OpenAI (whisper-1), used when Groq is not set
 *
 * No key -> isConfigured() is false and the webhook behaves as before.
 *
 * Both steps have hard time limits. The webhook answers Twilio before it
 * starts on a voice note (src/routes/webhook.js), so it passes generous
 * limits; the short defaults are for a caller that is still holding Twilio's
 * 15-second webhook open. A slow or failed transcription returns null and the
 * caller tells the client it could not listen.
 */

const { config } = require('../config');
const { logger } = require('../lib/logger');

const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
};

/** Both providers refuse files over 25 MB. */
const MAX_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 4_000;
const TRANSCRIBE_TIMEOUT_MS = 8_000;

function provider() {
  const t = config.transcription;
  if (t.provider && PROVIDERS[t.provider] && t.keys[t.provider]) return t.provider;
  if (t.keys.groq) return 'groq';
  if (t.keys.openai) return 'openai';
  return null;
}

function isConfigured() {
  return config.transcription.enabled && Boolean(provider());
}

const isAudio = (contentType) => /^audio\//i.test(String(contentType || ''));

/** The audio attachments of a Twilio webhook body: [{ url, contentType }]. */
function audioMedia(body = {}) {
  const n = Math.min(Number.parseInt(body.NumMedia, 10) || 0, 10);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (body[`MediaUrl${i}`] && isAudio(body[`MediaContentType${i}`])) {
      out.push({ url: body[`MediaUrl${i}`], contentType: body[`MediaContentType${i}`] });
    }
  }
  return out;
}

/** Any attachment at all (image, document, audio)? */
const hasMedia = (body = {}) => (Number.parseInt(body.NumMedia, 10) || 0) > 0;

/** Twilio media lives on api.twilio.com. Nothing else is fetched with our credentials. */
function isTwilioMediaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)twilio\.com$/i.test(u.hostname);
  } catch { return false; }
}

async function withTimeout(ms, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}

/** Download one media file from Twilio. @returns {Promise<Buffer|null>} */
async function downloadMedia(url, log = logger, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  if (!isTwilioMediaUrl(url)) {
    log.warn('transcription.media_url_rejected', {});
    return null;
  }
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken) return null;
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      // Twilio answers with a redirect to its media store; fetch follows it
      // and drops the Authorization header on the way, as it should.
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
        signal,
      });
      if (!res.ok) {
        log.warn('transcription.download_failed', { status: res.status });
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        log.warn('transcription.bad_size', { bytes: buf.length });
        return null;
      }
      return buf;
    });
  } catch (err) {
    log.warn('transcription.download_error', { message: err.name === 'AbortError' ? 'timed out' : err.message });
    return null;
  }
}

const EXTENSIONS = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/aac': 'aac' };

/** Send audio bytes to Whisper. @returns {Promise<string|null>} the transcript */
async function transcribeBuffer(buffer, contentType = 'audio/ogg', log = logger, timeoutMs = TRANSCRIBE_TIMEOUT_MS) {
  const name = provider();
  if (!name) return null;
  const { url, model } = PROVIDERS[name];
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `voice.${EXTENSIONS[type] || 'ogg'}`);
  form.append('model', config.transcription.model || model);
  form.append('response_format', 'json');
  const startedAt = Date.now();
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.transcription.keys[name]}` },
        body: form,
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log.warn('transcription.failed', { integration: name, status: res.status, detail: detail.slice(0, 200) });
        return null;
      }
      const text = String((await res.json())?.text || '').trim();
      log.info('transcription.done', { integration: name, duration_ms: Date.now() - startedAt, chars: text.length, bytes: buffer.length });
      return text || null;
    });
  } catch (err) {
    log.warn('transcription.error', { integration: name, message: err.name === 'AbortError' ? 'timed out' : err.message });
    return null;
  }
}

/**
 * Transcribe the first voice note of a webhook body.
 * @returns {Promise<string|null>} the transcript, or null when there is none
 */
async function transcribeWebhookAudio(body, log = logger, { downloadTimeoutMs, transcribeTimeoutMs } = {}) {
  const [first] = audioMedia(body);
  if (!first || !isConfigured()) return null;
  const buffer = await downloadMedia(first.url, log, downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS);
  if (!buffer) return null;
  return transcribeBuffer(buffer, first.contentType, log, transcribeTimeoutMs || TRANSCRIBE_TIMEOUT_MS);
}

/** Probe for /health/integrations. Makes no network call: a key is or is not set. */
function healthCheck() {
  const name = provider();
  return name && config.transcription.enabled
    ? { status: 'ok', configured: true, provider: name }
    : { status: 'not_configured', configured: false };
}

module.exports = {
  isConfigured, provider, isAudio, audioMedia, hasMedia, isTwilioMediaUrl,
  downloadMedia, transcribeBuffer, transcribeWebhookAudio, healthCheck,
};
