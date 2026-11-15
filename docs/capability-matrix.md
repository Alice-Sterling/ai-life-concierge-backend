# Capability matrix: what Alice does, what the Human Desk does

**The rule:** Alice never promises something the backend cannot do. She searches, checks, proposes
and hands over. Anything that costs money or commits the client is done by a person on the desk.

The rule is in Alice's prompt on every message (`src/agents/promptBuilder.js capabilityBlock`,
branch `project-4`), next to the older rules it reinforces: "never invent a venue, time, price or
link that a tool did not return" (`src/services/agentTools.js`) and "you cannot make final bookings
or payments" (`src/services/handoff.js`).

"Live" below = production on 15 Nov 2026 (`AGENT_TOOLS_ENABLED=true`). When this page and the code
disagree, the code is right and this page needs fixing.

## The matrix

| The client wants | Alice (the AI) | Human Desk | Tool or code behind Alice's part |
|---|---|---|---|
| **A restaurant table, 1 to 6 guests** | Checks live availability, proposes 2 to 3 real places with times and a booking link. The client can book through the link themselves. | Makes the booking when the client asks the team to. Confirms it. | `check_dining_availability` (OpenTable). If OpenTable has nothing, the tool falls back to Google Maps venues; for those the table is **not** checked and the team confirms it. |
| **Private dining, a members' club, more than 6 guests** | Collects venue, date and guest count. Drafts the inquiry. Does **not** check availability. | Sends the inquiry to the venue, negotiates, confirms. | `submit_private_inquiry` (a draft for the desk; nothing is emailed by the backend) |
| **A gift or flowers** | Finds real, listed products with price, shop link, and the delivery date where the shop shows one. | Orders, pays, confirms delivery. A delivery date is only certain once the desk has ordered. | `source_retail_gift` (Google Shopping) |
| **Tours, experiences, attraction tickets** | Finds bookable options with price, rating and link. | Books and pays when asked. | `search_curated_experiences` (GetYourGuide) |
| **Local events** | Finds ticketed events with date, venue and ticket link. The source often has no ticket price. | Buys tickets when asked. | `search_local_events` (Eventbrite) |
| **A car now (Uber)** | Sends a pre-filled Uber link. The client books in their own Uber app with one tap. | — | `request_transit` |
| **A car later, or "you book it"** | Says an Uber link cannot set a future time. Confirms pickup, drop-off and time, then hands over. | Books in Uber Central, Wheely or a local firm. Confirms. | `queue_local_dispatch` (puts the client in human mode) |
| **A UK train** | Sends a National Rail link with stations, date and time filled in. The client buys there. | Buys the tickets when asked. | `search_rail_routes` |
| **"Am I free on Friday?"** | Reads the client's own calendar, if it is connected. | — | `check_calendar_availability` (the client's own token) |
| **Put it in my calendar** | Cannot. Says the team sends a calendar invite with the booking. | Sends the invite. | (no tool: the calendar is read-only for the backend) |
| **Date night, a milestone, a trip, the weekly briefing** | Sends the reminder at the right time, then proposes options with the tools above. | Books what the client picks. | `src/services/dateNight.js`, `proactiveFlows.js` |
| **Preferences** ("I'm vegetarian", "I'm in Dubai this week") | Saves them and uses them from then on. | Can also edit them in Airtable. | `save_onboarding_profile`, `save_date_night_preferences`, `set_active_timezone` |
| **A voice note** *(Project 4, needs a key)* | Turns it into text and answers it like a typed message. If she cannot, asks the client to type. | Sees the transcript in the chat view. | `src/integrations/transcription.js` |
| **Remembering the client** *(Project 4, off until switched on)* | Keeps a short summary and key facts from older conversations. | Sees them in the context panel. | `src/agents/memory.js` |
| **Any booking, payment, purchase or reservation** | **Never.** Hands over the moment the client chooses. | **Always.** | `handoff_to_concierge` |
| **Cancel, pause or change the membership; refunds; billing** | **Cannot today.** Says the team will take care of it and hands over. | Handles it in Stripe and Airtable. | Not built. Planned in Project 4 (`apply_free_month`, `pause_membership`, `cancel_membership`). |
| **Flight delays and gate changes** | **Cannot.** She only notices a flight in the calendar and offers transport. | — | Not built (`monitor_linked_event` is in the brief, no flight feed yet). |
| **Email or call a venue, a shop or anybody else** | **Cannot.** | Does it. | No sending tool exists. `execute_action` (email through Composio) is in the code but is never offered in production: no `COMPOSIO_API_KEY`. |
| **Search the open web** | **Not in production.** She uses her tools and the Black Book. | — | Web search needs `TAVILY_API_KEY`, which is not set. |
| **A message outside 24 hours of the client's last one** | Only the approved WhatsApp templates. Free text is not delivered by WhatsApp. | Same limit: the composer refuses with `outside_24h_window`. | `src/services/templates.js`, `commandCenter.sendHumanMessage` |

## What a hand-over does

`handoff_to_concierge` (and `queue_local_dispatch`) does three things at once
(`src/services/handoff.js`):

1. The client goes to **human mode**. Alice stops replying.
2. A **task** is created with the booking brief, the chosen option's link, phone and price, and is
   copied to the Airtable Tasks table.
3. An **email** goes to the desk.

Alice then tells the client, in one line, that the team is arranging it. She comes back by herself
when the human window ends (two hours after the last human action), or when the desk hands the
client back.

## What Alice must not say

| She must not say | Unless |
|---|---|
| "It's booked / reserved / confirmed" | the conversation shows the team confirmed it |
| "I've paid / ordered / bought" | never: she cannot |
| "I've added it to your calendar" | never: she cannot |
| "I've emailed the restaurant" | never: she cannot |
| "It will arrive on Tuesday" | a tool returned that delivery date, and she says the team confirms at checkout |
| "Your membership is cancelled / paused" | never today: the desk does it |
| A venue, time, price or link | a tool returned it in this conversation |

## Keeping this page true

- A new tool for Alice: add its row here in the same change, and say what the desk still does.
- A tool that starts to act for real (book, pay, send): move the line between the two columns here
  **and** in `capabilityBlock`, or Alice will keep handing over something she could now do.
- The unit test `tests/agents/agent-modules.cjs` ("CAPABILITY BOUNDARY") fails if the block stops
  naming the hand-off tool or drops one of the rules above.
