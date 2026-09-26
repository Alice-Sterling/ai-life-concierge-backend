# Ai Life Concierge — Backend

WhatsApp concierge. Twilio for messaging, Anthropic for the agent, PostgreSQL
for state, Airtable as the ops dashboard.

```bash
npm install
cp .env.example .env     # DATABASE_URL is the only one required
npm start
```

| Command | Does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with file watching |
| `npm test` | Integration tests |
| `npm run migrate:up` | Apply database changes |

> Tests **drop and recreate the schema**. Set `TEST_DATABASE_URL` to a
> throwaway database. Never production.

---

## Deploying

The schema change is split in two so the rollout takes **zero downtime**. The
two halves straddle the deploy:

```
1. db/sql/001a_prepare.sql     <- safe while the OLD code is live
2. deploy the code
3. db/sql/001b_finalize.sql    <- safe while the NEW code is live
4. db/sql/002_verify.sql       <- every row must say PASS
```

**The order is not optional.** `onboarding_phase` changes from an INTEGER step
counter to the Airtable status text, and the counter moves to `onboarding_step`.
Doing it in one shot around a deploy breaks WhatsApp either way round:

- code before SQL -> the new code queries a column that does not exist yet
- SQL before code -> the old code writes integers into a text column

`001a` only adds things, so the running app does not notice. `001b` retires the
old column once nothing is using it, re-syncing the counter first so a user who
was mid-onboarding during the deploy does not lose their place.

Take a database backup before step 1.

Run each file with:

```bash
npm run db:apply db/sql/001a_prepare.sql
```

Railway's Data tab cannot run these - it is a table browser that executes one
statement and appends its own LIMIT. Use the command above.

**Rollback:** `db/sql/001_mvp_schema_down.sql` restores the integer column and
its values, and drops the new tables.

---

## Layout

```
server.js              start up, shut down
src/config/            all env vars, validated at boot
src/middleware/        request ids, helmet, rate limits, admin auth, errors
src/integrations/      airtable, twilio, anthropic, email, stripe
src/services/          users, tasks, events, conversations
src/routes/            portal, webhook, stripe, health, admin
src/jobs/              the nudge cron
src/legacy/            agent brain, moved verbatim from index.js
db/sql/                SQL to paste into Railway
db/migrations/         same changes, as node-pg-migrate
```

`src/legacy/concierge.js` holds the agent prompts and tool wiring, moved
word-for-word rather than rewritten — restructuring and rewriting at once would
make any regression impossible to trace. It should be broken up later, one piece
at a time, each with a test.

---

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Landing page |
| GET | `/portal` | 301 → `/` |
| GET | `/health` | Liveness. Point monitors here. |
| GET | `/health/integrations` | All five dependencies. Makes real API calls — don't poll. |
| POST | `/webhook` | Twilio. Signature checked in production. |
| POST | `/stripe-webhook` | Stripe. Signature checked in production. |

**Admin** — all need `Authorization: Bearer $ADMIN_API_TOKEN`:

| Method | Path |
| --- | --- |
| GET | `/admin/users` |
| GET | `/admin/tasks?status=new` |
| GET | `/admin/conversations/:userId` |
| POST | `/admin/users/:userId/mode` — `{"conversation_mode":"human"}` |

---

## Human hand-off

Set a user's `conversation_mode` to `human` and the webhook:

1. Saves the message with no AI reply
2. Creates a task for `assist@ailifeconcierge.co.uk`
3. Records a `human_handoff_created` event
4. Sends a short acknowledgement — **the agent stays quiet**

Checked before any agent work, so an operator is never talked over.

---

## Three deviations from the brief

**1. `onboarding_phase` was already taken.** It existed as an INTEGER step
counter (1–8), read in six places including the agent's prompt. The counter
moved to `onboarding_step`; `onboarding_phase` is now VARCHAR holding
`Waitlist`, `Approved`, `Denied`, `Onboarded`, `Active`, `Inactive`. A CHECK
constraint rejects typos like `Onboarded`.

Existing users are all seeded to `Waitlist` so the onboarding gates still apply
to them. Nobody is mass-promoted. Ops sets individual accounts by hand.

**2. SendGrid isn't wired up.** Mail goes over SMTP via nodemailer.
`SENDGRID_API_KEY` is read but never sends anything. The health check reports on
SMTP and says separately whether a SendGrid key exists.

**3. `events.user_id` isn't a foreign key.** `portal_viewed` fires before a user
exists, and funnel history should outlive a deleted user.

---

## Three bugs found and fixed

| Bug | Impact |
| --- | --- |
| `new GoogleGenAI(key)` passed a string, not an options object | Remove `GEMINI_API_KEY` and the process **died at startup** |
| `getUserByPhone` had a hand-typed column list missing the new columns | `conversation_mode` was always undefined — the hand-off gate **silently never fired** |
| `init-db.sql` re-declared `onboarding_phase INTEGER`, and runs on every boot | Would have undone the migration on the next restart |

---

## Notes

- **Webhooks return 200 on internal failure.** A 5xx makes Twilio and Stripe
  retry, replaying the whole flow. Failures go to the logs.
- **Airtable writes are best-effort.** Airtable being down never fails a reply.
- **`events` and `automation_logs` never sync to Airtable**, per the brief.
- **`trust proxy` is `1`**, not `true` — Railway adds one hop, and trusting all
  of them lets a caller spoof their IP past the rate limiter.
- **`init-db.sql` runs on every boot.** That's how a fresh deploy gets a schema.

**Logs** are one JSON object per line, each carrying a `request_id` that is also
returned in the `x-request-id` header. Search by it to follow one message end to
end. Credential-shaped fields are redacted.

## Known gaps

- `src/legacy/` still holds ~2,400 lines that belong in `src/services/`
- Integration tests only, no unit tests
- `npm audit` flags pre-existing vulnerabilities, one critical — not from this work
