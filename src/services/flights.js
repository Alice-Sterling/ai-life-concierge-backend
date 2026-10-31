/**
 * Spot a flight in a calendar event (Flow 4 part 1).
 *
 * Shapes seen in calendars:
 *   "Flight to Dubai (EK 2)"        Gmail / Outlook add these from booking emails
 *   "BA117 LHR-DXB", "EK2 LHR → DXB" typed by hand
 *   "Flight LHR to JFK"
 * Location is often the departure airport ("London LHR").
 *
 * A flight needs either the word "flight" (or ✈) or a flight number whose
 * airline code is on the list below, so "Q3 2026" or "M25" never count.
 */

/** Airline IATA codes we accept for a bare flight number (common for UK / Gulf / EU travel). */
const AIRLINES = new Set([
  'BA', 'VS', 'EK', 'EY', 'QR', 'LH', 'AF', 'KL', 'IB', 'LX', 'OS', 'SN', 'AZ', 'TP', 'SK', 'AY', 'EI',
  'U2', 'FR', 'W6', 'LS', 'BE', 'TK', 'AA', 'UA', 'DL', 'AC', 'B6', 'SQ', 'CX', 'QF', 'NZ', 'JL', 'NH',
  'KE', 'MH', 'TG', 'GA', 'AI', 'SV', 'GF', 'WY', 'MS', 'RJ', 'FZ', 'G9', 'ET', 'KQ', 'SA', 'LY', 'A3',
  'VY', 'DY', 'D8', 'EW', 'LO', 'OK', 'RO', 'JU', 'PC', 'XQ', 'HV', 'TO', 'BY', 'MT', 'LM', 'T3',
]);

/** Airports -> the city named in the ping ({{18}}). Unknown codes are shown as the code. */
const AIRPORT_CITY = {
  LHR: 'London', LGW: 'London', LCY: 'London', STN: 'London', LTN: 'London', SEN: 'London',
  MAN: 'Manchester', EDI: 'Edinburgh', GLA: 'Glasgow', BHX: 'Birmingham', BRS: 'Bristol', NCL: 'Newcastle',
  DUB: 'Dublin', JER: 'Jersey', GCI: 'Guernsey',
  DXB: 'Dubai', DWC: 'Dubai', AUH: 'Abu Dhabi', DOH: 'Doha', BAH: 'Bahrain', RUH: 'Riyadh', JED: 'Jeddah',
  KWI: 'Kuwait', MCT: 'Muscat', CAI: 'Cairo', AMM: 'Amman', TLV: 'Tel Aviv', IST: 'Istanbul', SAW: 'Istanbul',
  CDG: 'Paris', ORY: 'Paris', AMS: 'Amsterdam', BRU: 'Brussels', FRA: 'Frankfurt', MUC: 'Munich', BER: 'Berlin',
  ZRH: 'Zurich', GVA: 'Geneva', VIE: 'Vienna', CPH: 'Copenhagen', ARN: 'Stockholm', OSL: 'Oslo', HEL: 'Helsinki',
  MAD: 'Madrid', BCN: 'Barcelona', PMI: 'Palma', IBZ: 'Ibiza', AGP: 'Malaga', LIS: 'Lisbon', OPO: 'Porto',
  FAO: 'Faro', FCO: 'Rome', MXP: 'Milan', LIN: 'Milan', VCE: 'Venice', NAP: 'Naples', FLR: 'Florence',
  NCE: 'Nice', ATH: 'Athens', JMK: 'Mykonos', JTR: 'Santorini', PRG: 'Prague', BUD: 'Budapest', WAW: 'Warsaw',
  BTS: 'Bratislava', MLA: 'Malta', LCA: 'Larnaca',
  JFK: 'New York', EWR: 'New York', LGA: 'New York', BOS: 'Boston', MIA: 'Miami', LAX: 'Los Angeles',
  SFO: 'San Francisco', ORD: 'Chicago', IAD: 'Washington', LAS: 'Las Vegas', YYZ: 'Toronto',
  SIN: 'Singapore', HKG: 'Hong Kong', NRT: 'Tokyo', HND: 'Tokyo', BKK: 'Bangkok', DPS: 'Bali', MLE: 'Maldives',
  BOM: 'Mumbai', DEL: 'Delhi', SYD: 'Sydney', CPT: 'Cape Town', JNB: 'Johannesburg', MRU: 'Mauritius',
  SEZ: 'Seychelles', NBO: 'Nairobi', RAK: 'Marrakech',
};

const FLIGHT_WORD = /\bflight\b|✈/i;
const FLIGHT_NO = /\b([A-Z][A-Z0-9])\s?(\d{1,4})\b/g;
const ROUTE = /\b([A-Z]{3})\s*(?:-|–|→|>|to)\s*([A-Z]{3})\b/;
const TO_PLACE = /\bflight\s+to\s+([^()\n,]+?)(?:\s*\(|\s*$|,)/i;

const city = (code) => AIRPORT_CITY[code] || code;

/** The first flight number with a known airline code, e.g. 'EK2'. */
function flightNumber(text) {
  for (const m of String(text || '').matchAll(FLIGHT_NO)) {
    if (AIRLINES.has(m[1])) return `${m[1]}${m[2]}`;
  }
  return null;
}

/** An IATA code inside a location like "London LHR" or "Heathrow (LHR)". */
function airportIn(text) {
  for (const m of String(text || '').matchAll(/\b([A-Z]{3})\b/g)) if (AIRPORT_CITY[m[1]]) return m[1];
  return null;
}

/**
 * @param {{ title: string, location?: string|null, start?: string }} event
 * @returns {null | { flight: string|null, destination: string|null, from: string|null }}
 *   from = the departure airport code when known
 */
function detectFlight(event) {
  const title = String(event?.title || '');
  const number = flightNumber(title);
  if (!number && !FLIGHT_WORD.test(title)) return null;

  const route = ROUTE.exec(title);
  const toPlace = TO_PLACE.exec(title)?.[1]?.trim();
  const destination = (route && city(route[2])) || toPlace || null;
  const from = (route && route[1]) || airportIn(event.location) || null;

  // "Flight" alone with nothing else (e.g. "Book flight for mum") is not a flight to ping about.
  if (!number && !destination) return null;
  return { flight: number, destination, from };
}

/** {{10}} as approved ("5th of April"), in the client's timezone. */
function ordinalDate(date, tz = 'Europe/London') {
  const d = new Date(date);
  const part = (opts, zone) => new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: zone }).format(d);
  let zone = tz || 'Europe/London';
  try {
    part({ day: 'numeric' }, zone);
  } catch {
    zone = 'Europe/London';
  }
  const day = Number(part({ day: 'numeric' }, zone));
  const month = part({ month: 'long' }, zone);
  const suffix = (day % 100 >= 11 && day % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
  return `${day}${suffix} of ${month}`;
}

module.exports = { AIRLINES, AIRPORT_CITY, detectFlight, flightNumber, ordinalDate };
