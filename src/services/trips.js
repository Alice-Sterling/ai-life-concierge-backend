/**
 * Spot a trip in a calendar event (Flow 6, brief v2):
 *
 *   "Calendar detects a multi-day event starting in 14 days. The event MUST
 *    contain an IATA Airport Code OR the event Location must be > 50 miles
 *    from the user's home_city."
 *
 * Multi-day = an all-day event over 2+ days, or a timed one of 20+ hours.
 * The distance check uses OpenStreetMap (src/integrations/geocode.js); with no
 * home city on the profile only the airport-code rule can fire.
 */

const flights = require('./flights');
const geocode = require('../integrations/geocode');
const { logger } = require('../lib/logger');

const DAY_MS = 86400e3;
const MIN_MILES = 50;

/** All-day over 2+ days (Google/Outlook all-day "end" is the day after), or 20+ hours. */
function isMultiDay(event) {
  const start = new Date(event?.start).getTime();
  const end = new Date(event?.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return event.all_day ? end - start >= 2 * DAY_MS : end - start >= 20 * 3600e3;
}

/** The city an airport code in the title or location points to, or null. */
function airportDestination(event) {
  const code = flights.airportIn(event?.title) || flights.airportIn(event?.location);
  return code ? flights.AIRPORT_CITY[code] : null;
}

/** "Soho Farmhouse, Chipping Norton OX7" -> "Soho Farmhouse". */
const placeName = (location) => String(location || '').split(',')[0].trim() || null;

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * @param {object} event  from calendar.readEvents (includeFree, withLocation)
 * @param {string|null} home  the client's home city
 * @returns {Promise<null | { destination: string, rule: 'airport'|'distance', miles?: number }>}
 */
async function detectTrip(event, home, log = logger) {
  if (!isMultiDay(event)) return null;

  const byAirport = airportDestination(event);
  if (byAirport) return same(byAirport, home) ? null : { destination: byAirport, rule: 'airport' };

  if (!home || !event.location) return null;
  try {
    const [there, base] = await Promise.all([geocode.findPlace(event.location, log), geocode.findPlace(home, log)]);
    if (!there || !base) return null;
    const miles = Math.round(geocode.milesBetween(base, there));
    return miles > MIN_MILES ? { destination: placeName(event.location), rule: 'distance', miles } : null;
  } catch (err) {
    log.warn('trips.distance_check_failed', { message: err.message });
    return null;
  }
}

module.exports = { MIN_MILES, isMultiDay, airportDestination, placeName, detectTrip };
