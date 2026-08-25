# Handover guide

**This file is written for an AI coding assistant (Claude Code) helping a new owner
stand up this site on their own infrastructure.** If you are that assistant, read this
before touching anything — several details here are impossible to infer from the code
and will silently produce a half-working site if you get them wrong.

No secret *values* appear in this file, only variable names.

---

## 1. What this system is

A scheduling app for an ophthalmology practice, in two halves that share one dataset:

- **`index.html`** — the doctor scheduler. An admin builds Plans A/B/C for a month,
  optionally AI-generates assignments, marks one plan FINAL, and read-only portal
  accounts view it.
- **`techs.html`** — the technician scheduler. Technician assignments derive from the
  doctor schedule plus clinic load. Has its own plans and an explicit *publish* step.

Both are **single HTML files** using React 18 UMD + Babel-standalone, compiled **in the
browser**. There is no build step for the front end; `npm install` in the Netlify build
only provisions the serverless functions.

> **Consequence you must respect:** nested template literals break the in-browser Babel
> parser. Inside JSX, use string concatenation, never backticks. This bites on nearly
> every edit.

Notifications go out over Telegram (email is implemented and pluggable but unused).

### Architecture

```
index.html / techs.html
   ├─→ /.netlify/functions/storage-proxy   → Netlify Blobs ("schedule-helper")
   └─→ /.netlify/functions/claude-proxy    → Anthropic (EDGE function, for streaming)

tech-notify-cron  (*/5 * * * *, UTC)
   └─→ tech-notify-send-background  →  _lib/notify.mjs  →  Telegram Bot API

tech-day        public, HMAC-signed link  (/d?t=…)
telegram-webhook  inbound bot commands and account linking
```

All persistence is **Netlify Blobs**, store name `schedule-helper`. There is no SQL
database.

---

## 2. The four assets being transferred

| Asset | Where it lives | Moves how |
|---|---|---|
| Code | this Git repo | clone / transfer |
| **All user data** | Netlify Blobs, scoped to the Netlify **site** | export/import JSON, or transfer the site |
| Secrets | Netlify environment variables | re-enter by hand |
| Telegram bot | the previous owner's Telegram account | see §6 — the hard one |

**The critical fact:** Blobs are scoped to a Netlify *site*. Deploying this repo to a
new site gives you an **empty** store. Forking the repo transfers zero data.

---

## 3. Standing up a new site

1. Create a Netlify site from this repo. Build settings come from `netlify.toml`
   (`publish = "."`, `command = "npm install"`).
2. Set every environment variable in §4. The site will not function without them.
3. Deploy. Confirm `/` and `/techs.html` return 200.
4. Create the owner admin account: `CVE_USER` / `CVE_PASS` seed `user:<CVE_USER>` on
   first use. Sign in as that account.
5. Import the data (§5).
6. Point the Telegram webhook at the new domain (§6).

---

## 4. Environment variables

### Required

| Variable | Purpose | Notes for the new owner |
|---|---|---|
| `SESSION_SECRET` | Signs session JWTs | Generate a fresh one. Unset → the app returns 500 |
| `LINK_SECRET` | Signs the no-login day-view links in notifications | Copy the old value to keep previously-sent links working; generate a new one to invalidate them |
| `INTERNAL_SECRET` | Authenticates cron → background-sender | Generate fresh |
| `TELEGRAM_BOT_TOKEN` | The bot | From BotFather |
| `TELEGRAM_BOT_USERNAME` | Embedded in invite deep links | Must match the token's bot |
| `TELEGRAM_WEBHOOK_SECRET` | Validates inbound Telegram requests | Generate fresh, then re-register the webhook |
| `PUBLIC_BASE_URL` | Base for every generated link | The new domain, no trailing slash |
| `TECH_ADMIN_USERNAME` | **Defines the data namespace** | See §5 — must match the imported data |
| `ANTHROPIC_API_KEY` | AI schedule generation (edge function) | The new owner's own key and billing |
| `CVE_USER`, `CVE_PASS` | Seed the owner admin account | How you log in before importing |

### Optional / currently unused

`BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_WEBHOOK_SECRET`,
`EMAIL_DAILY_CAP` — the email channel. Unset means the adapter reports itself
unconfigured and is skipped; Telegram-only operation is fine.

`PARTNER_API_KEY`, `PARTNER_ORIGIN` — a read-only partner API.

`DEV_USERNAME`, `DEV_PASSWORD` — a legacy developer login. The UI for it was removed.
Leave unset.

> Mark genuine secrets as "contains secret values" in Netlify. `PUBLIC_BASE_URL`,
> `TELEGRAM_BOT_USERNAME` and `TECH_ADMIN_USERNAME` are not secret.

---

## 5. Importing the data

The old site produces one JSON file from **Managers → Backup & Transfer → Export all
data**. Import it from the same place on the new site.

### The namespace rule — read this before importing

Every piece of practice data is keyed `<tenant>:<name>`, where `<tenant>` is the owner
admin's username (historically `cve`). That name is *also* stamped inside every account
record as `adminUsername`, and the server rejects a write whose `adminUsername` does not
match the acting tenant.

**Simplest path by far: set `CVE_USER` (and `TECH_ADMIN_USERNAME`) on the new site to
the same username the old site used.** Then no rewriting is needed at all.

If the names differ, the importer rewrites the key prefix, rewrites `adminUsername`
inside each account, and **skips the old site's owner account** — you are already signed
in as this site's owner, and importing the old one would create a second admin pointing
at a namespace that no longer exists. The import report names any skipped account.

### Import order

The importer handles this, but if you ever script it manually, write in this order so a
pointer is never stored before the record it references:

1. tenant data keys (`<tenant>:*`)
2. `user:*` account records
3. `staffPortal:*` and `techPortal:*` reverse-lookups
4. `managers:<tenant>`

### Merge vs Replace

- **Merge** overwrites matching keys and leaves everything else. Safe default.
- **Replace** deletes tenant keys absent from the file first. Unrecoverable without
  another export; requires typing the tenant name to confirm.

### Never import these

`reset:*` (live password-reset tokens — importing them reinstates working
account-takeover links), `ratelimit:*`, and `<tenant>:telegramSeenUpdates` (webhook
dedup state; stale values can suppress real notifications). The exporter already omits
them.

---

## 6. Telegram — the part that cannot be copied cleanly

**BotFather has no ownership transfer.**

- **Keep the same bot token** → everything keeps working. Stored `telegramChatId`
  values stay valid. But the previous owner remains the bot's owner in BotFather and
  can revoke the token.
- **Create a new bot** → a genuine handover, but every stored `telegramChatId` is
  bound to the old bot and is now dead. **Every doctor, technician and administrator
  must re-link** by tapping a fresh invite. Plan this as a migration event; notifications
  are dark until each person acts.

Either way, register the webhook against the new domain:

```
https://api.telegram.org/bot<TOKEN>/setWebhook
  ?url=<PUBLIC_BASE_URL>/.netlify/functions/telegram-webhook
  &secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Verify with `getWebhookInfo` — `pending_update_count` should settle at 0.

---

## 7. Verification checklist

Do not declare the migration done until all of these pass.

- [ ] `/` and `/techs.html` return 200
- [ ] Owner admin signs in
- [ ] **A doctor portal user, a technician portal user, and a managed admin each sign
      in with their existing password** — this is the real test that accounts imported
      correctly; password hashes (PBKDF2) travel in the export, so passwords are unchanged
- [ ] The doctor month view shows historical schedules
- [ ] The technician month view shows published plans
- [ ] Export from the *new* site and diff it against the file you imported — anything
      that differs is a key the round-trip lost
- [ ] `/.netlify/functions/tech-notify` returns **401** to an unauthenticated POST
- [ ] `/d?t=bogus` returns **403**
- [ ] Telegram `/today` answers for a linked user
- [ ] AI generation runs (confirms `ANTHROPIC_API_KEY` and the edge function)

---

## 8. Data model reference

All keys below are prefixed `<tenant>:` unless stated otherwise.

**Doctor side** — `staff`, `locations`, `rules`, `holidays`, `vacations`,
`medicalLeaves`, `schedules`, `finalPlans`, `finalPlanStamps`, `dayNotes`, `planHistory`

**Technician side** — `techs`, `techSites`, `techStaffing`, `techRules`, `techTimeOff`,
`techSchedules`, `techFinalPlans`, `techPublished`, `techDayNotes`, `techAdmins`,
`techContacts`, `techNotifySettings`, `techNotifyLog`

**Not tenant-prefixed** — `user:<username>` (accounts, incl. PBKDF2 password hashes),
`staffPortal:<staffId>` and `techPortal:<techId>` (reverse-lookups to a username),
`managers:<tenant>` (managed admin list)

### Sensitivity

- `user:*` — password hashes. Treat an export like a password database.
- `techContacts` — email addresses and Telegram chat IDs. Deliberately excluded from
  portal-readable keys.
- `techTimeOff` — carries a free-text `reason` that may contain medical detail.
  Deliberately excluded from portal-readable keys; time off reaches the portal only as
  `OFF` baked into the published snapshot. **Review this before sharing an export.**

---

## 9. Landmines

**`list()` does not return other accounts.** A `list` call is filtered by
`isKeyReadable`, which grants an admin only `user:<self>`. Other accounts are found via
`managers:`, `staffPortal:` and `techPortal:`, then fetched individually — a `get` on
them succeeds through a different code path (`checkUserKeyAccess`). Any script that
enumerates via `list` alone will produce a backup containing every schedule and almost
no accounts, with no error.

**A doctor's `active` flag means "include in AI generation", not "still employed."** An
inactive doctor can be on the published plan and in clinic. Never filter on it outside
the generation path. The notification helper is named `notifiableDoctors()` for this
reason.

**`l3` and `l4` are retired location ids** (Stockton LASIK / LAL), migrated to `l2` on
load. Do not reuse those ids in test data — assignments referencing them get rewritten.

**Session JWT `exp` is in milliseconds**, not seconds.

**Netlify scheduled functions run in UTC and are capped at 30s.** The cron only decides
whether it is send time in the configured timezone and delegates to a `-background`
function, which may run up to 15 minutes.

**Netlify reuses modules across warm invocations.** A `Response` object built at module
scope is consumed on first use and fails afterwards; build responses per call. This
caused a bot outage once.

**`netlify/functions/_lib/` is not deployed as functions** — it is a shared library
directory.

---

## 10. Code map

| Path | Role |
|---|---|
| `index.html` | Doctor scheduler SPA (~7k lines) |
| `techs.html` | Technician scheduler SPA (~5.7k lines) |
| `netlify/functions/storage-proxy.mjs` | Auth + all Blob access. Every key permission lives here |
| `netlify/edge-functions/claude-proxy.mjs` | Streaming proxy to Anthropic |
| `netlify/functions/tech-notify.mjs` | Admin-triggered sends, invites, settings |
| `netlify/functions/tech-notify-cron.mjs` | 5-minute tick; decides send time |
| `netlify/functions/tech-notify-send-background.mjs` | Long-running sender |
| `netlify/functions/telegram-webhook.mjs` | Bot commands and account linking |
| `netlify/functions/tech-day.mjs` | Public signed day view (`/d`) |
| `netlify/functions/_lib/sendjob.mjs` | Builds recipients; audience scoping |
| `netlify/functions/_lib/sendlog.mjs` | Delivery log + change-detection snapshots |
| `netlify/functions/_lib/compose.mjs` | Message composition per channel and audience |
| `netlify/functions/_lib/techdata.mjs` | Blob loaders and shared scheduling helpers |
