/**
 * Address -> coordinates, with OpenStreetMap Nominatim (free, no key).
 *
 * Used by request_transit (the Uber link needs latitude/longitude) and, later,
 * Flow 6's "more than 50 miles from home" rule. Nominatim's usage policy
 * (operations.osmfoundation.org/policies/nominatim): at most 1 request per
 * second, an identifying User-Agent, cache the results, credit OpenStreetMap.
 * So requests here are queued one at a time, at least 1.1 s apart, and every
 * answer (also "not found") is cached in memory.
 */

const { logger } = require('../lib/logger');

const URL_BASE = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'AiLifeConcierge/1.0 (assist@ailifeconcierge.co.uk)';
const GAP_MS = 1100;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

const cache = new Map(); // key -> { at, value }
let queue = Promise.resolve();
let lastAt = 0;

const keyOf = (q) => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** One Nominatim jsonv2 result -> { lat, lon, name, address }. */
function parseResult(r) {
  if (!r) return null;
  const lat = Number.parseFloat(r.lat);
  const lon = Number.parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, name: r.name || null, address: r.display_name || null };
}

/** Run fn after the previous request, at least GAP_MS after it. */
function throttled(fn) {
  const next = queue.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  queue = next.catch(() => {});
  return next;
}

/**
 * Look an address or place up.
 * @returns {Promise<{lat:number, lon:number, name:string|null, address:string|null}|null>} null = not found
 * @throws on network/HTTP errors (the caller decides what that means)
 */
async function lookup(query, log = logger) {
  const key = keyOf(query);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await throttled(async () => {
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', addressdetails: '0' });
    const res = await fetch(`${URL_BASE}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const rows = await res.json();
    return parseResult(Array.isArray(rows) ? rows[0] : null);
  });

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  log.info('geocode.lookup', { integration: 'nominatim', found: Boolean(value) });
  return value;
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

/**
 * The searches to try for one address, best first. OSM misses some venue
 * names ("The Savoy, Strand, London" -> nothing; checked 31 Oct) but always
 * knows a UK postcode and the street.
 * @returns {{ q: string, match: 'exact'|'postcode'|'street' }[]}
 */
function attemptsFor(query) {
  const q = String(query || '').trim();
  const out = [{ q, match: 'exact' }];
  const noThe = q.replace(/^the\s+/i, '');
  if (noThe !== q) out.push({ q: noThe, match: 'exact' });
  const pc = UK_POSTCODE.exec(q);
  if (pc) out.push({ q: `${pc[1]} ${pc[2]}`.toUpperCase(), match: 'postcode' });
  const parts = q.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) out.push({ q: parts.slice(1).join(', '), match: 'street' });
  return out;
}

/**
 * Find a place, falling back to its postcode or street when the full text is not on the map.
 * @returns {Promise<({lat, lon, name, address, match}|null)>} match says how close the point is
 */
async function findPlace(query, log = logger) {
  for (const { q, match } of attemptsFor(query)) {
    const hit = await lookup(q, log);
    if (hit) return { ...hit, match };
  }
  return null;
}

/** Great-circle distance in miles. */
function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

module.exports = { lookup, findPlace, attemptsFor, parseResult, milesBetween };
