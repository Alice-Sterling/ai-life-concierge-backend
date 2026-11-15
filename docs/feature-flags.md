# Feature flags and settings

Every switch the backend reads, its default, what it was in production, and how to roll back.
Source of the defaults: `src/config/index.js` (and the few files named below).
"Live" = the Railway variables of the backend service, read on **15 Nov 2026**. A variable that is
"not set" runs on its default.

**How to change one:** Railway → project *worthy-contentment* → backend service → Variables. Saving
redeploys the service; the new value is live in about a minute. No code change, no migration.

**How to roll a feature back:** set its switch to `false` (or remove it, when the default is off).
Nothing is deleted: rows already written stay, and switching on again continues from them.

## Who may talk to Alice

| Variable | Default | Live | On | Off / rollback |
|---|---|---|---|---|
| `STATUS_GATE_ENABLED` | `false` | `true` | The front door: only clients whose status is Active reach Alice. Everyone else gets the template for their status (Waitlist, Approved, Onboarded, Denied, Inactive). An unknown number is not given an account. | Any number that writes gets an account and reaches Alice. |
| `STATUS_GATE_TEST_NUMBERS` | empty | set | These numbers go through the front door even while it is off for everyone else. | Remove the number. |
| `HUMAN_MODE_TIMEOUT_MINUTES` | `120` | not set | Length of the human window. When it has passed, Alice takes the client back. | `0` = Alice never takes a client back by herself. |
| `VERIFY_TWILIO_SIGNATURE` | on in production | not set | Refuses webhook calls that Twilio did not sign. Checked live on 15 Nov: an unsigned call gets 403. | Never switch off in production: anyone could then send messages as any client. |
| `VERIFY_STRIPE_SIGNATURE` | on in production | not set | Refuses Stripe webhooks that Stripe did not sign. | Same warning. |

## Messages Alice sends first

Each needs its WhatsApp template (the `TWILIO_TPL_*` variables below). All of them are stopped by a
lock, so a job that runs twice cannot send twice (`proactive_send_locks`, after migration 008).

| Variable | Default | Live | On | Off / rollback |
|---|---|---|---|---|
| `STRIPE_SETS_ACTIVE` | `false` | `true` | A finished Stripe checkout sets the client Active and sends the welcome. | Stripe only changes the tier; status is set in Airtable. |
| `ONBOARDING_REMINDER_ENABLED` | `false` | `true` | Approved but not onboarded after `ONBOARDING_REMINDER_HOURS` (24): one reminder per invitation. | No reminder. |
| `HANDSHAKE_PING_ENABLED` | `false` | `true` | `HANDSHAKE_PING_HOURS` (48) after activation, if the client has been quiet for 24 hours: one check-in. | No check-in. |
| `PROPOSAL_NUDGE_ENABLED` | `false` | `true` | Alice offered options and the client has not answered for `PROPOSAL_NUDGE_HOURS` (4): one nudge. | No nudge. |
| `DATE_NIGHT_PING_ENABLED` | `false` | `true` | A due date night sends the morning ping at `DATE_NIGHT_PING_HOUR` (9, client's time). | A due date night raises a task for the desk instead. |
| `WEEKLY_BRIEFING_ENABLED` | `false` | `true` | Weekly briefing ping on `WEEKLY_BRIEFING_DAY` (0 = Sunday) at `WEEKLY_BRIEFING_HOUR` (18), client's time. | No briefing. |
| `MILESTONE_PING_ENABLED` | `false` | `true` | A birthday or anniversary in the calendar `MILESTONE_DAYS_AHEAD` (21) days ahead: one ping per event, at `MILESTONE_PING_HOUR` (10). | No ping. |
| `TRANSIT_PING_ENABLED` | `false` | `true` | A flight in the calendar up to `TRANSIT_DAYS_AHEAD` (14) days ahead: one ping per flight, at `TRANSIT_PING_HOUR` (10). Needs `AGENT_TOOLS_ENABLED`. | No ping. |
| `TRAVEL_PING_ENABLED` | `false` | not set (off) | A multi-day trip up to `TRAVEL_DAYS_AHEAD` (14) days ahead: one ping, at `TRAVEL_PING_HOUR` (11). | Off today, waiting for the client's corrected template. |
| `LEGACY_TRIAL_NUDGE_ENABLED` | **`main`: on unless `false`. `project-4`: off unless `true`.** | **not set** | The old "30-day Pro Vault trial" offer to a lite-tier client 20 to 23 hours after they wrote. It contradicts the six-month Founding membership. | See the warning below. |

> **Warning (found 15 Nov).** `LEGACY_TRIAL_NUDGE_ENABLED=false` was set on 20 Oct. On 15 Nov it was
> not among the Railway variables, so on `main` the old offer is switched on again. Set
> `LEGACY_TRIAL_NUDGE_ENABLED=false` in Railway now. On `project-4` the default is reversed
> (`src/jobs/nudge.js`), so the offer stays off unless somebody asks for it.

## What Alice can do

| Variable | Default | Live | On | Off / rollback |
|---|---|---|---|---|
| `AGENT_TOOLS_ENABLED` | `false` | `true` | Alice has the search tools (dining, gifts, experiences, events, Uber link, rail link, private inquiry, car booked by the team). | Alice has only her base tools. The accounts in `TEST_TOOLS_USER_IDS` keep the tools either way. |
| `APIFY_TOKEN` | none | set | The search tools can run. | The tools answer "cannot verify"; Alice hands off. |
| `APIFY_MAX_RUNS_PER_USER_PER_DAY` / `APIFY_MAX_RUNS_PER_DAY` | `20` / `200` | not set | Cost guard on search runs. | Lower them to cut cost. |
| `AIRTABLE_PULL_ENABLED` | `true` | not set (on) | Edits the desk makes in the Airtable Clients table reach the backend on every message and every 15 minutes. | The 15-minute pull stops. |
| `PIPEDREAM_CALENDAR_ENABLED` | off unless `true` | not set | Brings back the old Pipedream tool for adding calendar events. | Alice says the team sends a calendar invite. |
| `TEST_TOOLS_USER_IDS` | Tim's account | not set | The accounts `/admin/test/*` may run jobs for. | Any other user gets 403. |

## Project 4 (on branch `project-4`; none of these is in production yet)

| Variable | Default | On | Off / rollback |
|---|---|---|---|
| `MEMORY_SUMMARY_ENABLED` | `false` | After a reply, messages that have left Alice's recent window are folded into the client's long-term memory (one Anthropic call per refresh). | Existing memories are still read; no new ones are written. To stop reading too, delete the row in `user_memory_summaries`. |
| `MEMORY_SUMMARY_MODEL` | `claude-sonnet-4-6` | The model that writes the memory. | — |
| `MEMORY_SUMMARY_MIN_MESSAGES` | `6` | Messages that must have aged out before a refresh. | — |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | none | Voice notes are transcribed (Groq wins if both are set). | No key = voice notes behave as before. |
| `VOICE_NOTES_ENABLED` | `true` | — | `false` switches transcription off even with a key. |
| `TRANSCRIPTION_PROVIDER`, `TRANSCRIPTION_MODEL` | automatic | Force `groq` or `openai`; change the model. | — |
| `ADMIN_TOKENS` | none | Named admin tokens with `read` or `write` scope. | Only `ADMIN_API_TOKEN` works. |
| `ADMIN_CORS_ORIGINS` | none | Browsers on these origins may call `/admin`. | No browser may. |
| `ADMIN_IP_ALLOWLIST` | none | Only these addresses may call `/admin`. | Any address (with a valid token). |
| `ADMIN_RATE_LIMIT_MAX` | `120` | Admin calls per minute per address. | — |
| `HUMAN_MODE_ALERT_EMAIL` | `assist@ailifeconcierge.co.uk` | Where "a client wrote while with a human" goes. | — |
| `SLACK_WEBHOOK_URL` | none | The same alert also goes to Slack. | Email only. |

## Templates

`TWILIO_TPL_<NAME>` holds the Twilio Content SID (`HX…`) of an approved WhatsApp template.
With no SID, the message goes as plain text when the client wrote in the last 24 hours, and is
**not sent at all** outside that window. Removing a SID is therefore the rollback for a template
that reads wrong.

Set live on 15 Nov: `UNRECOGNIZED_USER`, `STATUS_WAITLIST`, `STATUS_DENIED`, `STATUS_APPROVED`,
`MEMBERSHIP_INACTIVE`, `ACTIVE_WELCOME`, `ONBOARDING_REMINDER`, `HANDSHAKE_PING`, `DATENIGHT_PING`.
Built into the code as defaults: `WEEKLY_BRIEFING`, `MILESTONE_PING`, `TRANSIT_PING`, `TRAVEL_PING`.
**Not set:** `PENDING_STRIPE` (and `PAYMENT_URL`), so an Onboarded client is told the team will send
the payment link.

## Schedules

| Variable | Default | What runs |
|---|---|---|
| `LIFECYCLE_CRON_SCHEDULE` | every 15 minutes | Airtable pull, reminders, pings, briefings (each behind its own switch above). |
| `DATE_NIGHT_CRON_SCHEDULE` | minute 15 of every hour | The date-night sweep. |
| `HUMAN_MODE_RESUME_CRON` | every 5 minutes (`main`: every 10) | Hands clients back to Alice when their human window has passed. |
| `NUDGE_CRON_SCHEDULE` | every hour | The legacy trial nudge (see the warning above). |
| `BATCH_QUIET_MS` / `BATCH_SWEEP_MS` | `7000` / `2000` | How long a client must stop typing before Alice answers the whole burst, and how often that is checked. |
