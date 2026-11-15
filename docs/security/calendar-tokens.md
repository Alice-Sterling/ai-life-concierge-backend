# Calendar tokens: where they come from, where they live, how they change, how they go

A calendar token lets this backend read one client's Google or Outlook calendar. This page says
exactly what happens to it. Every statement points at the code that does it.

## 1. How a token is made

1. The client presses "connect calendar" on the website. The **n8n** workflow
   "Concierge Onboarding (Google + Outlook)" sends them to Google's or Microsoft's own login page.
   The client's password never reaches us.
2. Google / Microsoft sends n8n a one-time code. n8n swaps it for an **access token** (short-lived)
   and, on the first consent, a **refresh token** (long-lived).
3. n8n posts both to the backend: `POST /admin/calendar/connect` with
   `{ client_id, provider, access_token, refresh_token, expires_in, scope }`
   (`src/routes/admin.js`, `src/services/calendar.js saveConnection`).

The two OAuth apps are registered with Google and with Microsoft. Their ids and
secrets are in Railway (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`,
`MS_CLIENT_SECRET`) and in the n8n workflow.

## 2. How it is stored

| | |
|---|---|
| Where | Postgres, table `users`: `calendar_access_token_enc`, `calendar_refresh_token_enc` (both `BYTEA`), `calendar_token_expires_at`, `calendar_token_scope`, `calendar_token_updated_at`, `calendar_provider`, `calendar_connected` (migrations 003 and 006) |
| Encryption | AES-256-GCM, a fresh 12-byte IV per value, 16-byte authentication tag (`src/lib/crypto.js`). Stored as `[version 1][iv 12][tag 16][ciphertext]`. GCM also detects tampering: a changed byte makes the decrypt fail. |
| Key | `TOKEN_ENCRYPTION_KEY`, 32 bytes as 64 hex characters, **only** in the Railway environment. It is not in the database and not in the repository. A database dump without it yields no token. |
| No key | `saveConnection` refuses with 503 rather than store a token in clear text. |
| Health | After migration 008: `calendar_token_status` (`ok`, `refresh_failed`, `disconnected`), `calendar_token_last_refreshed_at`, `calendar_disconnected_at`. Shown in the Command Center's context panel. |

**Tokens are never shown.** The connect endpoint does not echo them. The logger replaces any string
field whose name contains `token`, `secret`, `password`, `api_key` or `authorization` with
`[redacted]` (`src/lib/logger.js`). The admin audit log does the same to request bodies
(`src/middleware/adminAudit.js`; tested: `tests/command-center.cjs`, "audit: tokens never stored").

## 3. How it is used

Only `src/services/calendar.js` decrypts a token, and only to call the provider:

- `readEvents` reads events between two times from the client's **own** calendar
  (Google `calendar/v3/calendars/primary/events`, Microsoft Graph `me/calendarView`).
- At connect time, one read of the calendar's timezone.

Alice (the model) never sees a token. She calls a tool; the tool returns event titles and times.
The backend does not write to calendars: for a booking, the team sends an invite.

## 4. How it changes (rotation)

| What | How | Who |
|---|---|---|
| **Access token** | Refreshed automatically when it has less than 2 minutes left (`getAccessToken`, `REFRESH_MARGIN_MS`), using the refresh token and the OAuth app's id and secret. The new one replaces the old in the database, encrypted. | Automatic |
| **Refresh token** | Replaced whenever the provider sends a new one with a refresh or a new login. A response that brings no refresh token keeps the stored one. | Automatic |
| **Refresh fails** | The provider answers `invalid_grant` (the grant is no longer valid, for example because the client removed access): `calendar_connected` goes to false and the status to `disconnected`, so Alice stops treating the calendar as connected and the client has to log in again. Any other failure is recorded as `refresh_failed`; the next calendar read tries again. | Automatic |
| **OAuth app secret** (`GOOGLE_CLIENT_SECRET`, `MS_CLIENT_SECRET`) | Make a new secret in Google Cloud / Entra, put it in Railway **and** in the n8n workflow, then delete the old one. Stored tokens keep working. | Client / developer |
| **`TOKEN_ENCRYPTION_KEY`** | **There is no re-encryption tool yet.** Changing the key makes every stored token unreadable: every client would have to connect their calendar again. If the key is ever believed leaked, that is the right outcome: change the key, run the deletion in section 5 for all clients, and ask them to reconnect. The version byte in the stored value exists so a re-encrypt script can be added without guessing what old rows contain. | Developer |

## 5. How it is deleted

| Case | What to do | What it does |
|---|---|---|
| A client asks to disconnect, cancels, or a leak is suspected | `POST /admin/users/<user id>/calendar/disconnect` (write token) | Sets both tokens, the expiry and the scope to NULL, `calendar_connected` to false, status `disconnected` with the time. Writes a `calendar_disconnected` event and an audit row naming who did it. Running it twice is harmless. (`calendar.disconnect`; on branch `project-4`.) |
| A client's account is deleted | Delete the `users` row | The tokens are columns of that row, so they go with it. Conversations, messages, tasks, queued and sent message records, send locks and the memory summary are deleted with it (`ON DELETE CASCADE`). Rows in `events`, `automation_logs` and `admin_audit_logs` stay: they hold the user id but no token and no message text from the calendar. |
| The provider side | The client removes the app in the list of connected apps of their Google or Microsoft account | The backend does not do this for them. Until they do, the grant exists at the provider, but we hold no token to use it. |

After a deletion `getAccessToken` returns nothing for that client (tested:
"no usable token is handed out afterwards").

## 6. Known gaps

- **Airtable.** Until 25 Oct 2026 the n8n workflow also wrote tokens into the Airtable columns
  "Access Token Calendar", "Refresh Token Calendar" and "Token Expiration". The workflow no longer
  writes them. The old values on the existing rows were still to be cleared when this page was
  written; they are plain text there and should be emptied.
- **n8n.** The Google and Microsoft app secrets sit in n8n node parameters, not in n8n credentials.
- **Key rotation** needs a script (section 4).
- **Backups.** Any backup of the database contains the encrypted columns as they were at that
  time. They are useless without the key, but a deleted token stays in a backup until that backup
  is gone.
