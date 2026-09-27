/**
 * Encryption for credentials held at rest.
 *
 * AES-256-GCM. GCM rather than CBC because it authenticates as well as
 * encrypts: tampering with the stored bytes fails the decrypt instead of
 * silently yielding a different token.
 *
 * The key lives only in TOKEN_ENCRYPTION_KEY, never in the database, so a
 * database dump on its own is worthless. Generate one with:
 *
 *     openssl rand -hex 32
 *
 * Stored layout, one BYTEA column:
 *
 *     [ version 1 ][ iv 12 ][ auth tag 16 ][ ciphertext ... ]
 *
 * The version byte is there so the scheme can be changed later without
 * guessing at what old rows contain.
 */

const crypto = require('crypto');

const VERSION = 1;
const IV_BYTES = 12;   // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const KEY_BYTES = 32;  // AES-256

let cachedKey = null;

/**
 * @returns {Buffer|null} the key, or null when encryption is not configured
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim() === '') return null;

  const key = Buffer.from(raw.trim(), 'hex');
  if (key.length !== KEY_BYTES) {
    // Fail loudly at first use. A short key would otherwise throw somewhere
    // far away, mid-request, with a confusing message.
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} characters); got ${key.length} bytes.`
    );
  }

  cachedKey = key;
  return cachedKey;
}

function isConfigured() {
  return getKey() !== null;
}

/**
 * @param {string} plaintext
 * @returns {Buffer} the value to store in a BYTEA column
 */
function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not set; refusing to store a credential in clear text.');

  // A fresh random IV per encryption. Reusing one under the same key breaks
  // GCM completely, so this must never be derived from the plaintext.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * @param {Buffer|null} stored
 * @returns {string|null} the plaintext, or null when there is nothing stored
 */
function decrypt(stored) {
  if (stored == null) return null;

  const key = getKey();
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not set; cannot decrypt.');

  const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('Stored credential is truncated.');

  const version = buf[0];
  if (version !== VERSION) throw new Error(`Unsupported credential format version: ${version}`);

  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  // Throws if the tag does not verify, which is the point: a tampered or
  // wrong-key value must fail, not return plausible rubbish.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isConfigured };
