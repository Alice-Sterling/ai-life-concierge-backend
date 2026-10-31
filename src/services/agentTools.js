/**
 * Alice's agent tools (Project 3, "Global Master Agent").
 *
 * The brief gives Alice a toolbelt so she verifies before she pitches and
 * hands real bookings to the desk. Each tool here is an Anthropic tool
 * definition plus a handler. The rules every tool follows:
 *
 *   - It checks or prepares; it never books or pays. Bookings stay human.
 *   - When it cannot check (provider down, not configured, an error), it says
 *     so with cannotVerify() and Alice hands the request to the desk instead
 *     of guessing.
 *   - The whole set is off until AGENT_TOOLS_ENABLED, except for the test
 *     accounts (config.testTools.userIds), so it can be tried on a real phone
 *     before any client sees it.
 *
 * Tools so far:
 *   queue_local_dispatch        no car service covers the trip -> the desk arranges a local taxi
 *   submit_private_inquiry      private dining / events -> an inquiry drafted for the desk to send
 *   check_dining_availability   live OpenTable tables (Apify); Google Maps venues as a fallback
 *   source_retail_gift          UK gifts and flowers: price, shop link, delivery (Apify, Google Shopping)
 *   search_curated_experiences  tours and activities (Apify, GetYourGuide search)
 *   search_local_events         ticketed local events (Apify, Eventbrite)
 */

const users = require('./users');
const tasks = require('./tasks');
const apify = require('../integrations/apify');
const email = require('../integrations/email');
const { DESK_EMAIL } = require('./handoff');
const { config } = require('../config');
const { logger } = require('../lib/logger');

const QUEUE_LOCAL_DISPATCH_TOOL = {
  name: 'queue_local_dispatch',
  description:
    'Ask the human desk to arrange a local taxi or car when no car service can be quoted for the trip '
    + '(for example outside Uber coverage, or the client wants a local firm). Use it only after the client '
    + 'has confirmed the pickup, drop-off and time. The desk books it and confirms; you do not.',
  input_schema: {
    type: 'object',
    properties: {
      pickup: { type: 'string', description: 'Pickup address or place, as exact as the client gave it.' },
      dropoff: { type: 'string', description: 'Drop-off address or place.' },
      time: { type: 'string', description: "Pickup date and time in the client's local time, e.g. 'Fri 31 Oct 18:30'." },
      reason: { type: 'string', description: 'Why a local car: e.g. no Uber coverage, luggage, client preference.' },
    },
    required: ['pickup', 'dropoff', 'time'],
  },
};

const SUBMIT_PRIVATE_INQUIRY_TOOL = {
  name: 'submit_private_inquiry',
  description:
    "Send a private dining or events inquiry to a venue's events team: members' clubs, private dining "
    + 'rooms, or any table for more than 6 people. Do NOT check live availability for these. The inquiry '
    + 'is drafted for the concierge desk, who send it to the venue and come back with the answer. Use it '
    + 'once the client has given the venue, the date and the number of guests.',
  input_schema: {
    type: 'object',
    properties: {
      venue: { type: 'string', description: 'Venue name, and area if known.' },
      date: { type: 'string', description: "Date and preferred time, in the client's local time." },
      guest_count: { type: 'integer', description: 'Number of guests, including the client.' },
      occasion: { type: 'string', description: 'Optional: client dinner, birthday, anniversary...' },
      requirements: { type: 'string', description: 'Optional: private room, dietary needs, budget, wine.' },
    },
    required: ['venue', 'date', 'guest_count'],
  },
};

const CHECK_DINING_TOOL = {
  name: 'check_dining_availability',
  description:
    'Check live table availability for a standard restaurant booking (1 to 6 guests) in an area, for a date, '
    + 'time and party size. Returns real restaurants with bookable times, price band, rating, address and the '
    + 'booking link. Use it BEFORE you suggest any restaurant. Not for more than 6 guests or members\' clubs '
    + '(use submit_private_inquiry).',
  input_schema: {
    type: 'object',
    properties: {
      area: { type: 'string', description: "Neighbourhood and city, e.g. 'Mayfair, London'." },
      date: { type: 'string', description: 'YYYY-MM-DD, in the client\'s local time.' },
      time: { type: 'string', description: 'Preferred time, HH:MM 24-hour, e.g. 19:30.' },
      party_size: { type: 'integer', description: 'Number of guests, 1 to 6.' },
      cuisine: { type: 'string', description: "Optional cuisine or keyword, e.g. 'Italian', 'sushi'." },
    },
    required: ['area', 'date', 'time', 'party_size'],
  },
};

const SOURCE_GIFT_TOOL = {
  name: 'source_retail_gift',
  description:
    'Find real, currently listed gifts or flowers from UK shops, with price and store. Use it before you '
    + 'suggest any gift or bouquet. Build the search from what you know about the recipient (style, budget, '
    + 'brands they like). Returns the shop\'s own product link and, where the shop shows it, the delivery date '
    + 'and fee.',
  input_schema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: "Product search, e.g. 'luxury peony bouquet next day delivery'." },
      budget_max_gbp: { type: 'number', description: 'Optional top price in GBP.' },
    },
    required: ['search'],
  },
};

const SEARCH_EXPERIENCES_TOOL = {
  name: 'search_curated_experiences',
  description:
    'Find bookable tours, private experiences and attraction tickets in a destination (GetYourGuide) with '
    + 'price, rating and booking link. Use it for travel itineraries and activities.',
  input_schema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: "City, e.g. 'Rome'." },
      interests: { type: 'string', description: "Optional, e.g. 'private boat tour', 'art', 'wine tasting'." },
    },
    required: ['destination'],
  },
};

const EVENT_CATEGORIES = [
  'arts', 'music', 'food-and-drink', 'business', 'film-and-media', 'sports-and-fitness',
  'fashion', 'charity-and-causes', 'community', 'health', 'hobbies', 'travel-and-outdoor',
];

const SEARCH_EVENTS_TOOL = {
  name: 'search_local_events',
  description:
    'Find ticketed local events (Eventbrite) in a city for a date range and category, with date, time, venue '
    + 'and ticket link. Use it for local cultural events.',
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: "City, e.g. 'London'." },
      country: { type: 'string', description: "Country, default 'United Kingdom'." },
      category: { type: 'string', enum: EVENT_CATEGORIES },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['city', 'category', 'start_date', 'end_date'],
  },
};

const TOOLS = [
  QUEUE_LOCAL_DISPATCH_TOOL, SUBMIT_PRIVATE_INQUIRY_TOOL,
  CHECK_DINING_TOOL, SOURCE_GIFT_TOOL, SEARCH_EXPERIENCES_TOOL, SEARCH_EVENTS_TOOL,
];
const NAMES = new Set(TOOLS.map((t) => t.name));

/** Does this user get the agent tools? Everyone once switched on; test accounts always. */
function enabledFor(userId) {
  if (config.agentTools.enabled) return true;
  return config.testTools.userIds.includes(String(userId || '').toLowerCase());
}

/** The tool definitions to give Alice for this user (empty while switched off). */
function definitionsFor(userId) {
  return enabledFor(userId) ? TOOLS : [];
}

const has = (name) => NAMES.has(name);

/** The brief's tool routing matrix, for the tools that exist so far. Empty while switched off. */
function promptBlock(userId) {
  if (!enabledFor(userId)) return '';
  return `
### AGENT TOOLS (verify before you pitch)
- Restaurants for 1 to 6 guests: call check_dining_availability first. Present only places it returns with an available time, and name the exact time.
- Members' clubs, private dining rooms, or more than 6 guests: call submit_private_inquiry. Do NOT check live availability for these.
- Gifts and flowers: call source_retail_gift first. Give the price, the shop and the delivery the shop shows (or say the team confirms the delivery date).
- Tours, activities and travel itineraries: call search_curated_experiences. Local cultural events: call search_local_events.
- A car the client has confirmed that no car service can quote (no coverage, or they want a local firm): call queue_local_dispatch.
- Present 2 to 3 contrasting options, never a long list. Never invent a venue, time, price or link that a tool did not return.
- EVERY option you present ends with its booking_link on its own line, as a plain URL, so the client can book or buy it themselves in one tap. Then offer that the team can arrange it for them instead.
- WhatsApp formatting: bold is *single asterisks*; never **double**, never markdown headings or [text](url) links.
- When the client picks one, call handoff_to_concierge and copy that option's booking_link, vendor_phone and price from the tool result into it.
- If a tool says it could not verify, do not present options: tell the client the team will check personally and call handoff_to_concierge.
`;
}

// ---- Apify results -> short, plain options for Alice -------------------------
// Alice reads these as tool results, so they stay small: a few options, only
// the fields she can use, and the link/phone/price the desk needs later.

const hhmmToMinutes = (s) => {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The 6 bookable slot times (HH:MM) closest to the requested time, within `windowMin`, in time order. */
function slotsNear(slots, time, windowMin = 90) {
  const want = hhmmToMinutes(time);
  const gap = (t) => (want == null ? 0 : Math.abs(hhmmToMinutes(t) - want));
  return (slots || [])
    .filter((s) => s && s.available !== false)
    .map((s) => String(s.dateTime || '').slice(11, 16))
    .filter((t) => gap(t) <= windowMin)
    .sort((a, b) => gap(a) - gap(b))
    .slice(0, 6)
    .sort();
}

/** OpenTable page that opens on the asked date, time and party size, so the client can book in one tap. */
function openTableLink(url, { date, time, party } = {}) {
  if (!url) return null;
  if (!date || !time) return url;
  const u = new URL(url);
  u.searchParams.set('covers', String(party || 2));
  u.searchParams.set('dateTime', `${date}T${time}`);
  return u.toString();
}

/** One OpenTable restaurant (rl1987/opentable-api-scraper) -> an option. */
function mapOpenTable(r, time, { date, party } = {}) {
  const avail = r.availabilitySlots || {};
  const slots = avail.slots || [];
  return {
    name: r.name,
    cuisine: (r.cuisines || []).join(', ') || null,
    price: r.priceBand || null,
    rating: r.rating ?? null,
    reviews: r.reviewCount ?? null,
    address: [r.address, r.postalCode].filter(Boolean).join(', ') || null,
    vendor_phone: r.phone || r.phoneNumber || r.profile?.phone || null,
    booking_link: openTableLink(r.url, { date, time, party }),
    available_times: slotsNear(slots, time),
    card_required: slots.some((s) => s.requiresCreditCard) || undefined,
    not_bookable_reason: (avail.noTimesReasons || [])[0] || undefined,
  };
}

/** One Google Maps place (compass/crawler-google-places) -> an option. Table not checked. */
function mapGooglePlace(p) {
  return {
    name: p.title,
    cuisine: p.categoryName || null,
    price: p.price || null,
    rating: p.totalScore ?? null,
    reviews: p.reviewsCount ?? null,
    address: p.address || null,
    vendor_phone: p.phone || null,
    booking_link: p.reserveTableUrl || p.tableReservationLinks?.[0]?.url || p.website || p.url || null,
  };
}

const parseGbp = (s) => {
  const n = Number.parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * One Google Shopping product (epctex/google-shopping-scraper, with offer
 * details) -> an option. merchantLink is Google's redirect to the shop's own
 * product page; resolveShopLink() turns it into that page.
 */
function mapProduct(p) {
  return {
    title: p.productName,
    store: p.merchantName || null,
    price: p.price || null,
    delivery: [p.deliveryInfo, p.deliveryFee && !String(p.deliveryInfo || '').includes(p.deliveryFee) ? `fee ${p.deliveryFee}` : null]
      .filter(Boolean).join(', ') || null,
    rating: p.reviewsScore ?? undefined,
    booking_link: p.merchantLink || p.productLink || null,
  };
}

/** Drop tracking parameters Google adds to shop links. */
function cleanShopUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (k === 'srsltid' || k.startsWith('utm_') || k === 'gclid') u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Google's /goto?url=... link -> the shop's product page (one redirect, not
 * followed further). Anything else, or a failure, keeps the link as it was:
 * a Google link still works for the client, it is just less direct.
 */
async function resolveShopLink(link) {
  if (!link || !/^https:\/\/www\.google\.[a-z.]+\/goto\?/.test(link)) return link;
  try {
    const res = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const to = res.headers.get('location');
    return to && /^https?:\/\//.test(to) ? cleanShopUrl(to) : link;
  } catch {
    return link;
  }
}

/** One tour (memo23/tours-activities-scraper) -> an option. */
function mapTour(t) {
  return {
    title: t.title,
    platform: t.provider || t.platform || null,
    price: t.price != null ? `${t.currency === 'GBP' ? '£' : `${t.currency || ''} `}${t.price}` : null,
    rating: t.rating ?? null,
    reviews: t.reviewCount ?? null,
    duration: t.durationText || undefined,
    // GetYourGuide adds search-tracking parameters; the page is the same without them.
    booking_link: t.url ? String(t.url).split('?')[0] : null,
  };
}

/** GetYourGuide's own search page. The actor's free-text "search" input ignored the term (31 Oct test). */
const gygSearchUrl = (term) => `https://www.getyourguide.com/s/?q=${encodeURIComponent(term)}`;

/** One Eventbrite event (xenondev/xenon-eventbrite-events) -> an option. */
function mapEvent(e) {
  const min = e.ticket_availability?.minimum_ticket_price;
  return {
    name: e.name,
    date: e.start_date || null,
    time: e.start_time || null,
    venue: [e.primary_venue?.name, e.primary_venue?.address?.city].filter(Boolean).join(', ') || null,
    price: e.ticket_availability?.is_free ? 'Free' : (min?.display || null),
    booking_link: e.url || null,
  };
}

/** Eventbrite's location slug: 'united-kingdom--london'. */
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const eventbriteCity = (city, country = 'United Kingdom') => `${slug(country)}--${slug(city)}`;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const PICK_NOTE = 'Present 2 to 3 contrasting options. When the client picks one, call handoff_to_concierge '
  + "with that option's booking_link, vendor_phone and price.";

/** The answer a tool gives when it could not check: Alice must not guess. */
function cannotVerify(reason) {
  return JSON.stringify({
    ok: false,
    verified: false,
    reason,
    instruction: 'Do not present unverified options. Tell the client the concierge team will check this '
      + 'personally, then call handoff_to_concierge with the full request.',
  });
}

const clientName = (user) => [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Client';
const clientLine = (user) =>
  `Client: ${clientName(user)}\nPhone: ${user.phone_number || ''}\nClient ID: ${user.short_id || user.client_id || ''}`;

/** A desk task plus an email to the desk. Alice keeps talking: this is not a hand-off. */
async function deskTask(user, { subject, summary, category = 'general', priority = 'high', sourceMessage, requestId }, log) {
  const task = await tasks.create({
    userId: user.id,
    sourceMessage,
    aiSummary: summary,
    category,
    priority,
    requiresHuman: true,
    assignedTo: DESK_EMAIL,
    requestId,
  }, log);

  if (email.isConfigured()) {
    await email.send({
      to: DESK_EMAIL,
      subject: `${subject}: ${clientName(user)}`,
      text: `${summary}\n\nTask ID: ${task.task_id}\nRequest ID: ${requestId || ''}`,
    }, log);
  } else {
    log.warn('agent_tool.email_not_configured', { task_id: task.task_id });
  }
  return task;
}

const HANDLERS = {
  async queue_local_dispatch(user, input, ctx, log) {
    const summary = [
      'LOCAL DISPATCH: please book a local taxi or car and confirm to the client.',
      '',
      clientLine(user),
      `Pickup: ${input.pickup}`,
      `Drop-off: ${input.dropoff}`,
      `Time: ${input.time} (client's local time${user.active_timezone ? `, ${user.active_timezone}` : ''})`,
      `Reason: ${input.reason || 'not given'}`,
    ].join('\n');
    const task = await deskTask(user, { ...ctx, subject: 'LOCAL DISPATCH', summary }, log);
    return {
      ok: true,
      task_id: task.task_id,
      note: 'The desk is arranging the car. Tell the client in one line that a local car is being '
        + 'arranged and the team will confirm the details shortly. Do not promise a price or a driver.',
    };
  },

  async submit_private_inquiry(user, input, ctx, log) {
    const guests = Number.parseInt(input.guest_count, 10);
    const draft = [
      `Subject: Private dining inquiry, ${input.date}, ${Number.isFinite(guests) ? guests : '?'} guests`,
      '',
      `Dear ${input.venue} events team,`,
      '',
      `We would like to inquire about a private booking on ${input.date} for `
        + `${Number.isFinite(guests) ? guests : 'a group of'} guests`
        + `${input.occasion ? ` (${input.occasion})` : ''}.`,
      input.requirements ? `Requirements: ${input.requirements}.` : null,
      '',
      'Could you let us know your availability, room options and minimum spend?',
      '',
      'Kind regards,',
      'Ai Life Concierge',
      DESK_EMAIL,
    ].filter((l) => l !== null).join('\n');

    const summary = [
      `PRIVATE DINING INQUIRY: please send the draft below to ${input.venue}'s events team, then update the client.`,
      '',
      clientLine(user),
      '',
      '--- Draft email ---',
      draft,
    ].join('\n');
    const task = await deskTask(user, { ...ctx, subject: 'PRIVATE INQUIRY', summary, category: 'client_event' }, log);
    return {
      ok: true,
      status: 'drafted_for_desk',
      task_id: task.task_id,
      note: "The inquiry is drafted and with the desk, who will send it to the venue's events team. "
        + 'Tell the client that, and that you will update them as soon as the venue replies. '
        + 'Do not claim the venue has confirmed anything.',
    };
  },

  async check_dining_availability(user, input, ctx, log) {
    const party = Number.parseInt(input.party_size, 10) || 2;
    if (party > 6) {
      return { ok: false, use_instead: 'submit_private_inquiry', note: 'More than 6 guests: send a private inquiry instead.' };
    }
    if (!isDate(input.date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
    if (!apify.isConfigured()) return JSON.parse(cannotVerify('Live availability is not set up yet.'));

    const time = hhmmToMinutes(input.time) != null ? input.time : '19:30';
    const found = await apify.run('opentable', {
      mode: 'search',
      location: input.area,
      q: input.cuisine || '',
      includeAvailability: true,
      includeDetails: true,
      date: input.date,
      time,
      partySize: party,
      maxItems: 6,
    }, { userId: user.id, maxItems: 6 }, log);

    const restaurants = found.map((r) => mapOpenTable(r, time, { date: input.date, party }));
    const open = restaurants.filter((r) => r.available_times.length);
    if (open.length) {
      return {
        ok: true,
        verified: true,
        source: 'OpenTable, live',
        request: { area: input.area, date: input.date, time, party_size: party },
        options: open.slice(0, 4),
        fully_booked_near_that_time: restaurants.filter((r) => !r.available_times.length).map((r) => r.name),
        note: `${PICK_NOTE} Quote the exact available times.`,
      };
    }
    if (restaurants.length) {
      return {
        ok: true,
        verified: true,
        options: [],
        fully_booked_near_that_time: restaurants.map((r) => r.name),
        note: 'Nothing bookable within 90 minutes of that time. Offer another time or date, or a different area, '
          + 'and check again. Do not suggest these restaurants for the requested time.',
      };
    }

    // Not on OpenTable here: real venues from Google Maps, table not checked.
    const places = await apify.run('googleMaps', {
      searchStringsArray: [`${input.cuisine || ''} restaurant in ${input.area}`.trim()],
      maxCrawledPlacesPerSearch: 4,
      language: 'en',
      scrapeTableReservationProvider: true,
      skipClosedPlaces: true,
    }, { userId: user.id, maxItems: 4 }, log);
    if (!places.length) return JSON.parse(cannotVerify('No restaurants found for that area.'));
    return {
      ok: true,
      verified: false,
      source: 'Google Maps (table availability NOT checked)',
      options: places.map(mapGooglePlace),
      note: 'These are real, open venues, but their tables are not checked. You may suggest them only as '
        + '"the team will confirm a table". ' + PICK_NOTE,
    };
  },

  async source_retail_gift(user, input, ctx, log) {
    if (!apify.isConfigured()) return JSON.parse(cannotVerify('Live product search is not set up yet.'));
    const found = await apify.run('googleShopping', {
      queries: [input.search],
      countryCode: 'gb',
      maxItems: 5,
      includeSponsoredResults: false,
      // Opens each product's offer: the shop's own link, delivery date and fee.
      includeComparisonPrices: true,
      includeExtraProductDetails: true,
    }, { userId: user.id, maxItems: 5 }, log);

    const max = Number(input.budget_max_gbp);
    const products = found
      .map(mapProduct)
      .filter((p) => p.title && p.price)
      .filter((p) => !(max > 0) || (parseGbp(p.price) ?? Infinity) <= max)
      .slice(0, 4);
    if (!products.length) return JSON.parse(cannotVerify('No listed products matched that search and budget.'));
    await Promise.all(products.map(async (p) => { p.booking_link = await resolveShopLink(p.booking_link); }));
    return {
      ok: true,
      verified: true,
      source: 'Google Shopping UK, live listings',
      options: products,
      delivery_note: 'Where "delivery" is given it is what the shop shows today; otherwise say the team confirms '
        + 'the delivery date. Either way the team double-checks at checkout.',
      note: PICK_NOTE,
    };
  },

  async search_curated_experiences(user, input, ctx, log) {
    if (!apify.isConfigured()) return JSON.parse(cannotVerify('Live experience search is not set up yet.'));
    const term = [input.destination, input.interests].filter(Boolean).join(' ');
    const found = await apify.run('tours', {
      startUrls: [{ url: gygSearchUrl(term) }], maxItems: 5, includeReviews: false, country: 'gb',
    }, { userId: user.id, maxItems: 5 }, log);
    const tours = found.map(mapTour).filter((t) => t.title && t.booking_link);
    if (!tours.length) return JSON.parse(cannotVerify(`No bookable experiences found for ${term}.`));
    return {
      ok: true,
      verified: true,
      source: 'GetYourGuide, live listings',
      options: tours,
      note: `${PICK_NOTE} Dates are confirmed by the team when booking.`,
    };
  },

  async search_local_events(user, input, ctx, log) {
    if (!isDate(input.start_date) || !isDate(input.end_date)) return { ok: false, error: 'Dates must be YYYY-MM-DD.' };
    if (!apify.isConfigured()) return JSON.parse(cannotVerify('Live event search is not set up yet.'));
    const country = input.country || 'United Kingdom';
    const found = await apify.run('eventbrite', {
      city: eventbriteCity(input.city, country),
      country: slug(country),
      category: EVENT_CATEGORIES.includes(input.category) ? input.category : 'arts',
      startDate: input.start_date,
      endDate: input.end_date,
      maxPages: 1,
      maxItems: 6,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'GB' },
    }, { userId: user.id, maxItems: 6 }, log);
    const events = found.map(mapEvent).filter((e) => e.name && e.booking_link);
    if (!events.length) return JSON.parse(cannotVerify('No events found for that city and dates.'));
    return {
      ok: true,
      verified: true,
      source: 'Eventbrite, live listings',
      options: events,
      note: `${PICK_NOTE} Ticket prices are shown on the event page; the team confirms them.`,
    };
  },
};

/**
 * Run one tool call for Alice.
 * @returns {Promise<string>} the tool_result content (JSON)
 */
async function run(name, input, { userId, sourceMessage = null, requestId = null } = {}, log = logger) {
  const toolLog = log.child({ agent_tool: name, user_id: userId });
  if (!has(name) || !enabledFor(userId)) return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
  try {
    const user = await users.findById(userId, toolLog);
    if (!user) return JSON.stringify({ ok: false, error: 'User not found.' });
    const result = await HANDLERS[name](user, input || {}, { sourceMessage, requestId }, toolLog);
    toolLog.info('agent_tool.done', { ok: result.ok !== false });
    return JSON.stringify(result);
  } catch (err) {
    toolLog.error('agent_tool.failed', { message: err.message });
    return cannotVerify(`The ${name} tool failed: ${err.message}`);
  }
}

module.exports = {
  TOOLS, enabledFor, definitionsFor, has, promptBlock, cannotVerify, run,
  // result shaping, exported for tests
  slotsNear, mapOpenTable, mapGooglePlace, mapProduct, mapTour, mapEvent, eventbriteCity, parseGbp, gygSearchUrl,
  openTableLink, cleanShopUrl, resolveShopLink,
};
