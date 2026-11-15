# System map

How the pieces fit: who a client is at each stage, what happens to a WhatsApp message, what runs
on a timer, and how calendars and Airtable stay in step. Written 15 Nov 2026 from the code on
branch `project-4`. Parts marked **(P4)** are on that branch and not yet in production.

## 1. The pieces

```
 Client's WhatsApp
        │
        ▼
     Twilio ───────────────► POST /webhook ──────────────┐
        ▲                                                 │
        │ replies, templates                              ▼
        │                                   ┌──────────────────────────┐
        └────────────────────────────────── │  Backend (Node, Railway) │
                                            │  server.js + src/        │
 Website (Lovable) ──► n8n ──► Airtable ◄──►│                          │──► Anthropic (Alice)
        │               │      (desk's      │  Postgres (Railway)      │──► Apify (search tools)
        │               │       view)       │  = source of truth       │──► Google / Microsoft calendars
        │               └─ POST /admin/… ──►│                          │──► SendGrid SMTP (desk email)
        ▼                                   └──────────────────────────┘──► OpenAI / Groq Whisper (P4)
     Stripe ──────────► POST /stripe-webhook            ▲
                                                        │ GET/POST /admin/… (token)
                                     Command Center (Lovable, P4) ── the desk
```

| Piece | What it is for |
|---|---|
| **Postgres** | The source of truth: users, conversations, messages (P4), tasks, events, send records. |
| **Airtable** | What the desk looks at and edits: the Clients table and the Tasks table. A copy, kept in step both ways. |
| **n8n** (the client's) | Small jobs: website forms, the calendar login, telling the backend when Airtable changes, the alarm emails. |
| **Twilio** | The WhatsApp line. Every message in and out goes through it. |
| **Railway** | Runs the backend and the database. A push to `main` deploys in about a minute. |

## 2. A client's life

A client's stage is `users.onboarding_phase`. It mirrors the **Status** cell of their Airtable
row, which the desk and the website workflows set. The backend reads it; it writes it only when
Stripe activates a client.

| Status | Who they are | What a WhatsApp message gets (front door on) |
|---|---|---|
| *(unknown number)* | Not in Postgres and not in Airtable | The "unrecognised" template. No account is made. |
| **Waitlist** | Signed up on the website | The waitlist template, then one short follow-up, then silence for 6 hours. |
| **Approved** | Invited | The invitation with their personal onboarding link. A reminder after 24 hours if they have not onboarded. |
| **Onboarded** | Form done, not yet paid | The "one final step" message (with the payment link when `PAYMENT_URL` is set). The desk is told what they asked. |
| **Active** | A member | The welcome, once. Then **Alice**. |
| **Inactive** | Membership lapsed | The inactive template. "Help" raises a task and an email for the desk. |
| **Denied** | Turned down | The denied template. |

How a status changes:

- **In Airtable** (the desk, or a website workflow): n8n notices within 5 minutes and calls
  `POST /admin/users/status-changed`; the backend copies the status and sends that status's
  template. The front door also re-reads Airtable on every message.
- **By Stripe**: a finished checkout (`checkout.session.completed`) sets Active, stamps
  `activated_at` and sends the welcome (`STRIPE_SETS_ACTIVE`). The 180-day trial counts from there.
- **(P4)** `users.account_status` is the brief's five-value view of the same thing (Active, Paused,
  Cancelled, Waitlist, Denied), kept in step by a database trigger.

## 3. What happens to one WhatsApp message

`src/routes/webhook.js`, in this order:

1. **Signature.** A call Twilio did not sign is refused (403).
2. **Voice note? Answer Twilio first (P4).** If the message is audio and a Whisper key is set, the
   webhook returns its response at once and does the steps below in the background, so a long
   note cannot run into Twilio's 15-second limit.
3. **Who is it.** The sender's number finds the user. With the front door on, an unknown number is
   looked up in Airtable; if nobody knows it, it is turned away.
4. **Transcript and message log (P4).** A voice note is downloaded from Twilio and transcribed;
   `[AUDIO TRANSCRIPT] …` becomes the message text. The message is then written to `messages`
   (the chat view), whatever happens next.
5. **Front door.** Status routing (the table above). Only Active goes on.
6. **Human mode.** If the client is with a human: Alice stays silent, the message is queued as a
   task, the desk is alerted (P4: email, Slack if set), and the client gets the holding line (P4:
   once per hand-over).
7. **Batching.** The message is queued. When the client has stopped typing for 7 seconds, the whole
   burst goes to Alice as one message.
8. **Alice.** `src/legacy/concierge.js runAgenticConcierge` builds her context and calls Anthropic
   (`claude-sonnet-4-6`) with her tools. If Anthropic fails, the code tries a Gemini fallback.
9. **Reply.** Sent through Twilio, recorded in `conversations` (what Alice reads as history),
   `outbound_messages` (delivery record) and `messages` (P4).
10. **Memory (P4, behind a switch).** In the background, older messages are folded into the
    client's long-term memory.

What Alice is given on every turn: her system prompt, the client's profile and status, open desk
tasks, calendar status, her tools and their rules, what she may and may not do (P4), her long-term
memory of the client (P4), a summary of slightly older turns, and the last eight turns.

Hand-over to a human: Alice calls `handoff_to_concierge` → the client goes to human mode, a task
goes to Airtable, the desk gets an email. A person replies from the Command Center (P4) and Alice
returns two hours after the last human action, or when the desk hands the client back.
See `capability-matrix.md` for who does what.

## 4. What runs on a timer

All inside the backend process (`node-cron`), started in `server.js`. Each proactive message has
its own switch (`feature-flags.md`) and is recorded so it is never sent twice.

| Job | When | What |
|---|---|---|
| Batch sweeper | every 2 s | Answers bursts that have gone quiet. |
| Human-mode resume | every 5 min (P4; 10 on `main`) | Hands clients back to Alice when the human window has passed. |
| Lifecycle | every 15 min | Airtable → backend pull; onboarding reminder; 48-hour check-in; 4-hour nudge on unanswered options; weekly briefing; milestone, transit and travel pings (calendar-driven). |
| Date night | hourly, at :15 | Sends the date-night ping when a client's next date night is due (morning, their time). |
| Legacy trial nudge | hourly | The old 30-day offer. Must stay off: see the warning in `feature-flags.md`. |

Outside the backend, in n8n: Airtable status change → backend (5 min poll); Airtable task status →
backend (5 min poll); the alarm workflow (every 5 min: `/health`, `/admin/alarms`, Twilio's error
log → email to the desk and the developer).

## 5. Calendar sync

```
website "connect calendar" → n8n → Google / Microsoft login → tokens
        → POST /admin/calendar/connect → encrypted in Postgres, calendar_connected = true,
          the client's timezone taken from the calendar
```

- **Reading:** when Alice needs it (`check_calendar_availability`) and when the proactive jobs look
  ahead (milestones, flights, trips). Always the client's own calendar with their own token.
- **Refreshing:** an access token with under two minutes left is refreshed first. If the provider
  says the grant is gone, the client is marked disconnected.
- **Writing:** none. The team sends a calendar invite with a booking.
- **Deleting (P4):** `POST /admin/users/:id/calendar/disconnect`.

Full detail: `security/calendar-tokens.md`.

## 6. Airtable sync

| Direction | What | How |
|---|---|---|
| Backend → Airtable | Client row: status, conversation mode, next date night, name, email, phone | On every change to those fields (`users.pushToAirtable`). Best-effort: Airtable being down never blocks a reply. |
| Backend → Airtable | Tasks, with Booking Link, Vendor Phone, Price | When a task is created or its status changes (`tasks.syncToAirtable`). |
| Airtable → backend | Status | n8n poll (5 min) and at the front door on every message. |
| Airtable → backend | Profile fields (home city, work city, partner, dietary, cuisine), automations, conversation mode, date-night cadence, next date due | On every message and every 15 minutes (`airtableSync.js`). Only cells that changed since last seen are applied. |
| Airtable → backend | Task closed or in progress | n8n poll (5 min) → `POST /admin/tasks/:id/status`. |

Never sent to Airtable: `events`, `automation_logs`, `messages`, the audit log, tokens.

`GET /health/airtable-schema` **(P4)** checks that every table and field the backend uses still
exists, because a renamed column makes a sync fail without anyone seeing an error.

## 7. Every door into the backend

| Route | Who calls it | Protected by |
|---|---|---|
| `POST /webhook` | Twilio | Twilio signature |
| `POST /stripe-webhook` | Stripe | Stripe signature |
| `GET /health` | Uptime checks, the n8n alarm | open, no data |
| `GET /health/integrations` | A person, rarely (it makes paid API calls) | open, no client data |
| `GET /health/airtable-schema` (P4) | Uptime checks | open, field names only |
| `GET /go/<site>/<code>` | A client tapping a short link | open; redirects to the booking page |
| `GET /` | Browsers | the old portal page |
| `/admin/*` | n8n, the Command Center (P4), the developer | Admin token (P4: named tokens with read or write scope, optional IP allowlist), rate limit, audit log (P4) |

The admin routes are listed in `command-center-api.md`.

## 8. When something breaks

- The alarm workflow emails the desk and the developer what failed and the likely fix
  (`src/services/alarms.js`).
- Railway → backend → Logs. Every line is JSON with an `event` name and a `request_id`; one
  message can be followed from the webhook to the reply by its `request_id`.
- A feature misbehaves: switch it off in Railway (`feature-flags.md`).
- WhatsApp silent with 429s: check Railway → backend → Settings → Edge ("Under Attack Mode").
