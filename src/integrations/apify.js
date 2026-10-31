/**
 * Apify: the live-availability scrapers behind Alice's agent tools.
 *
 * The brief v2 (30 Oct): "Apify is the new MultiOn". Each tool runs one Apify
 * actor and waits for its items (run-sync-get-dataset-items), so Alice gets
 * real tables, prices and links in the same reply.
 *
 * Every run is bounded three ways, so a stuck or greedy actor cannot run up a
 * bill: a time limit (Apify stops the run), an item limit, and a USD cap per
 * run (Apify's maxTotalChargeUsd). On top of that a daily run count per client
 * and in total (in memory, resets on restart and at UTC midnight).
 *
 * Any failure throws ApifyError; the tool turns it into "cannot verify" and
 * Alice hands the request to the desk instead of guessing.
 */

const { config } = require('../config');
const { logger } = require('../lib/logger');

const API = 'https://api.apify.com/v2';

/**
 * The actors in use, picked and tested on UK examples 31 Oct 2026 (prices are
 * Apify's pay-per-event list prices on that day, Starter plan).
 */
const ACTORS = {
  // OpenTable search + live slots for a date/time/party: ~$0.0015/restaurant,
  // $0.003/availability check, $0.003/profile (phone). 3 Mayfair places, 9 s, $0.02.
  opentable: { id: 'rl1987/opentable-api-scraper', maxChargeUsd: 0.5 },
  // Google Maps places with phone, rating, price level, reservation link:
  // $0.003/place. Fallback when OpenTable has nothing.
  googleMaps: { id: 'compass/crawler-google-places', maxChargeUsd: 0.5 },
  // Google Shopping UK products with price + store: $0.0035/result, 4 s.
  googleShopping: { id: 'damilo/google-shopping-apify', maxChargeUsd: 0.5 },
  // Tours from a GetYourGuide search page (its free-text "search" input ignored
  // the term in the 31 Oct test): $0.005 start + $0.002/tour, 20 s.
  tours: { id: 'memo23/tours-activities-scraper', maxChargeUsd: 0.5 },
  // Eventbrite UK events by city + category + dates: ~$0.005/event, 8 s.
  eventbrite: { id: 'xenondev/xenon-eventbrite-events', maxChargeUsd: 0.5 },
};

class ApifyError extends Error {}

function isConfigured() {
  return Boolean(config.apify.token);
}

// Daily run counts: { day: 'YYYY-MM-DD', total: n, perUser: Map<userId, n> }
let usage = { day: null, total: 0, perUser: new Map() };

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Count a run against the daily limits, or throw if one is reached. */
function reserveRun(userId) {
  if (usage.day !== today()) usage = { day: today(), total: 0, perUser: new Map() };
  const mine = usage.perUser.get(userId) || 0;
  if (usage.total >= config.apify.maxRunsPerDay) {
    throw new ApifyError('Daily search limit reached for the service.');
  }
  if (userId && mine >= config.apify.maxRunsPerUserPerDay) {
    throw new ApifyError('Daily search limit reached for this client.');
  }
  usage.total += 1;
  if (userId) usage.perUser.set(userId, mine + 1);
}

/** For tests. */
function resetUsage() {
  usage = { day: null, total: 0, perUser: new Map() };
}

/**
 * Run an actor and return its dataset items.
 * @param {keyof ACTORS} key
 * @param {object} input the actor's own input
 * @param {{ userId?: string, maxItems?: number, timeoutSecs?: number }} opts
 * @returns {Promise<object[]>}
 */
async function run(key, input, { userId = null, maxItems = 10, timeoutSecs = config.apify.timeoutSecs } = {}, log = logger) {
  const actor = ACTORS[key];
  if (!actor) throw new ApifyError(`Unknown actor: ${key}`);
  if (!isConfigured()) throw new ApifyError('Apify is not configured (APIFY_TOKEN).');
  reserveRun(userId);

  const params = new URLSearchParams({
    timeout: String(timeoutSecs),
    maxItems: String(maxItems),
    maxTotalChargeUsd: String(actor.maxChargeUsd),
    clean: 'true',
  });
  const url = `${API}/acts/${actor.id.replace('/', '~')}/run-sync-get-dataset-items?${params}`;
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apify.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      // A little longer than the run's own limit, so Apify answers first.
      signal: AbortSignal.timeout((timeoutSecs + 15) * 1000),
    });
  } catch (err) {
    log.warn('apify.request_failed', { integration: 'apify', actor: actor.id, message: err.message });
    throw new ApifyError(err.name === 'TimeoutError' ? 'The search timed out.' : 'The search service could not be reached.');
  }

  const ms = Date.now() - startedAt;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn('apify.run_failed', { integration: 'apify', actor: actor.id, status: res.status, ms, body: body.slice(0, 300) });
    throw new ApifyError(res.status === 408 ? 'The search timed out.' : `The search failed (HTTP ${res.status}).`);
  }

  const items = await res.json().catch(() => null);
  if (!Array.isArray(items)) throw new ApifyError('The search returned no readable results.');
  log.info('apify.run_done', { integration: 'apify', actor: actor.id, items: items.length, ms });
  return items.slice(0, maxItems);
}

/** Connectivity probe for /health/integrations: reads the account, runs nothing. */
async function healthCheck() {
  if (!isConfigured()) return { status: 'not_configured', configured: false };
  const startedAt = Date.now();
  try {
    const res = await fetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${config.apify.token}` },
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: res.ok ? 'ok' : 'error',
      configured: true,
      latency_ms: Date.now() - startedAt,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return { status: 'error', configured: true, error: err.message };
  }
}

module.exports = { ACTORS, ApifyError, isConfigured, run, healthCheck, resetUsage };
