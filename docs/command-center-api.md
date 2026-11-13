# Command Center API (Project 4)

What the Lovable Command Center calls. Everything here is built and tested
(`node tests/command-center.cjs`, 123 checks). Base URL in production:
`https://ai-life-concierge-backend-production.up.railway.app`.

## Before it works in production

1. Apply `db/sql/008_command_center.sql` to the production database (additive, safe to run twice).
2. Railway variables (all optional except the token you give the dashboard):

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_TOKENS` | JSON list of named tokens: `[{"actor":"command-center","token":"<32+ random chars>","scope":"write"}]`. `scope` is `read` or `write`. Optional `"ips":["1.2.3.4","10.0.0.0/24"]`. Tokens under 16 characters are ignored. | none |
| `ADMIN_API_TOKEN` | The original shared token. Still works (actor `legacy-admin`, write). n8n uses it. | set |
| `ADMIN_CORS_ORIGINS` | Comma-separated browser origins allowed to call `/admin` (the dashboard's URL). | none: browsers are refused |
| `ADMIN_IP_ALLOWLIST` | Comma-separated IPs / IPv4 CIDR ranges for all admin calls. | any address |
| `GROQ_API_KEY` or `OPENAI_API_KEY` | Switches voice-note transcription on. Groq wins if both are set. | off |
| `VOICE_NOTES_ENABLED` | `false` switches transcription off even with a key. | `true` |
| `ADMIN_RATE_LIMIT_MAX` | Admin calls per minute per address (was fixed at 30). | `120` |
| `HUMAN_MODE_TIMEOUT_MINUTES` | Length of the human window. `0` = never auto-resume. | `120` |
| `HUMAN_MODE_ALERT_EMAIL` | Where "a client wrote while with a human" goes. | `assist@ailifeconcierge.co.uk` |
| `SLACK_WEBHOOK_URL` | Also post that alert to Slack (name only, no message text). | off |

## Auth

`Authorization: Bearer <token>`. Add `X-Admin-Actor: <person's email>` so the
audit log records the person, not only the system (`command-center:alice@...`).

| Case | Answer |
|---|---|
| No or wrong token | 401 |
| Read-only token on a POST | 403 `This token is read-only` |
| Address not in the allowlist | 403 |
| More than the admin rate limit | 429 |

A token in browser code can be read by anyone who opens the page. Keep the
token on a server (a Lovable / Supabase edge function that forwards the call)
and let the browser talk to that.

## Endpoints

### `GET /admin/inbox` — pane 1
Every client with their last message, most recently active first.

```json
{ "count": 3, "unread": 1, "threads": [ {
  "user_id": "uuid", "first_name": "Tim", "last_name": "Antos", "phone_number": "whatsapp:+44...",
  "conversation_mode": "human", "human_override_until": "2026-11-13T19:02:11Z",
  "account_status": "Active", "cohort_id": null, "onboarding_phase": "Active",
  "last_message": "Hello??", "last_direction": "inbound", "last_sender_type": "user",
  "last_message_at": "2026-11-13T17:02:11Z", "unread": true } ] }
```

- Mode badge: `conversation_mode` `ai` = green, `human` = red.
- `unread` = the client is in human mode and wrote last (someone owes a reply).
- `last_message` is cut to 160 characters.

### `GET /admin/users`
The user list. Adds `mode`, `account_status`, `cohort_id`, `trial_duration_days`,
`human_override_until`, `calendar_token_status`, `trial_started_at`,
`trial_ends_at`, `trial_days_left` to the fields it already returned.

### `GET /admin/conversations/:userId` — pane 2
`?limit=` (default 200, max 500), `?before=<ISO time>` for older pages.

```json
{ "user": { "id": "uuid", "conversation_mode": "ai", "human_override_until": null, "account_status": "Active" },
  "message_count": 2,
  "messages": [
    { "id": "uuid", "direction": "inbound",  "sender_type": "user",  "content": "Hello Alice", "metadata": {}, "created_at": "..." },
    { "id": "uuid", "direction": "outbound", "sender_type": "alice", "content": "Good evening, Tim.", "metadata": {}, "created_at": "..." } ],
  "conversations": [ "...the older one-row-per-exchange list, unchanged..." ] }
```

`sender_type` decides the bubble:

| `sender_type` | Bubble |
|---|---|
| `user` | left, grey |
| `alice` | right, blue |
| `human_agent` | right, purple (`metadata.actor` = who) |
| `system` | centre, small text ("Human mode engaged by ...") |

A transcribed voice note is a `user` message starting with `[AUDIO TRANSCRIPT]`.
Template messages appear as their readable text, with `metadata.template_key`.

### `GET /admin/users/:userId/context` — pane 3
```json
{ "headline": "Active | cohort_1_alpha | Trial expires in 42 days",
  "status": { "account_status": "Active", "onboarding_phase": "Active", "cohort_id": "cohort_1_alpha",
              "trial_duration_days": 180, "trial_started_at": "...", "trial_ends_at": "...", "trial_days_left": 42 },
  "conversation": { "mode": "ai", "human_override_until": null, "mode_changed_at": "..." },
  "calendar": { "connected": true, "provider": "google", "token_status": "ok",
                "token_last_refreshed_at": "...", "disconnected_at": null },
  "lifestyle_preferences": { "Home City": "London", "Partner Name": "Ana", "Dietary Restrictions": "gluten-free" },
  "recent_tasks": [ { "task_id": "uuid", "status": "in_progress", "category": "date_night", "ai_summary": "...",
                      "links": { "booking_url": "https://...", "phone_number": "+44 20 ...", "tel_link": "tel:+4420...",
                                 "contact_email": null, "formatted_address": null, "price": "£75" } } ] }
```

- `recent_tasks`: the three latest, read from Postgres (the same tasks the backend mirrors to Airtable).
  The per-message "queued while in human mode" tasks are left out.
- `links` are read from the task summary lines `Booking link:`, `Vendor phone:`, `Price:`,
  `Contact email:`, `Address:`. Today a hand-off writes the first three.

### `POST /admin/users/:userId/mode` — the Take Over toggle
Body `{ "mode": "human" }` or `{ "mode": "ai" }`.
Answer `{ "ok": true, "conversation_mode": "human", "human_override_until": "..." }`.
`human` starts (or restarts) the two-hour window; `ai` clears it. A system note goes into the chat.

### `POST /admin/messages/send` — the composer
Body `{ "user_id": "uuid", "content": "text up to 1600 characters" }`.
Sends through Twilio, logs the message as `human_agent`, puts the client in human mode
(or restarts the window if already there).

| Code | `code` | Meaning |
|---|---|---|
| 200 | | sent |
| 400 | `empty_message`, `message_too_long` | |
| 404 | `user_not_found` | |
| 409 | `outside_24h_window` | The client has not written for 24 hours. WhatsApp will not deliver free text; only an approved template. Nothing was sent. |
| 409 | `duplicate_send` | The same text to the same client within 10 seconds (a double click). |
| 502 | `twilio_send_failed` | Twilio refused it. A system note says so in the chat. |
| 503 | `twilio_not_configured` | |

### `GET /admin/audit`
`?limit=`, `?user_id=`, `?actor=`. Who called what: `actor`, `route`, `user_id`, `action`,
`request_body_redacted`, `status_code`, `ip`, `request_id`, `timestamp`. Refused calls are in it too.
Anything named like a token, secret, password or key is stored as `[redacted]`.

### `GET /health/airtable-schema` (no token)
200 when every Airtable table and field the backend uses exists; 503 with a `problems` list
when one was renamed or deleted. Cached for five minutes (`?fresh=1` checks again). Also run once at boot.

## Behaviour behind the endpoints

- **Human window.** `human_override_until` = last human action + `HUMAN_MODE_TIMEOUT_MINUTES`.
  Human actions: Take Over, a sent message, Alice's own hand-off. A job every 5 minutes hands
  the client back to Alice when it has passed. A client who keeps writing does not move it.
- **Client writes in human mode.** Alice stays silent. The desk gets an email (once per client per
  10 minutes). The client gets the holding line once per hand-over, not after every message.
- **Voice notes.** The webhook answers Twilio at once, then downloads the audio from Twilio and
  transcribes it in the background (up to 60 seconds), so a long note does not hit Twilio's
  15-second limit. The transcript is the message text for the desk and for Alice. If transcription
  fails the client is asked to type instead. With `OPENAI_API_KEY` the model is `whisper-1`
  (`TRANSCRIPTION_MODEL` changes it); files over 25 MB are refused.
- **No duplicate proactive sends.** Each proactive template claims a row in
  `proactive_send_locks` (client + template + period) before it sends.
