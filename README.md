# Headwater

**Headwater** is a Cloudflare Worker that rebuilds a **Streem-style** media-monitoring feed in Slack
from Meltwater's **Generic Webhook** (Smart Alerts). It receives each alert, filters to a
curated signal, reformats it into a tight Slack Block Kit message (with link-unfurling
disabled), and posts it — replacing Meltwater's noisy built-in Slack feed.

- **Ingestion:** Meltwater Generic Webhook → `POST /webhooks/meltwater/:token`
- **Pipeline:** `parse → filter → dedupe → syndication-merge → post` (`src/lib/process.ts`)
- **Streem-style output:** source + icon, bold linked headline, snippet with matched keywords as `code` pills (or a `Mentions: kw (n)` line), and an **Author | Organisation Brief** footer. Slack auto-unfurl is disabled.
- **Syndication de-dup:** the same wire story across many outlets collapses into one message that lists every outlet (`📡 Also in: …`) — via `chat.update`.
- **Tuning surface:** `src/config/feed.config.ts` (briefs, keywords, source allow/block, reach, media types)
- **Broadcast station names:** radio/TV alerts don't carry the station — it's resolved from Meltwater's JS viewer and cached in D1 (see [Broadcast station names](#broadcast-station-names))
- **Persistence (D1):** `webhook_events` (raw + parsed + decision, powers `/inspect`), `seen_mentions` (dedupe), `stories` (syndication tracking + `render_hash` for the redecode backfill), `broadcast_stations` + `station_names` (radio/TV station resolution), `ops_state` (heartbeat bookkeeping)
- **Cloudflare resources:** **Workers** (the app), **D1** (all persistence above), and **Browser Rendering** (the `browser` binding — headless Chromium, used *only* for first-time station-name resolution; a few seconds per new station, well within the free 10 min/day)
- **Inspect:** `GET /inspect` (Cloudflare Access) — recent events, raw payload, filter decision + reason, Block Kit preview
- **Monitoring:** `GET /health` validates the runtime config (`configOk`); an hourly cron **heartbeat** alerts Slack if ingestion goes quiet (`src/lib/heartbeat.ts`)

Deferred (not built): RSS-poll fallback and the native REST API path. Print is excluded (no plan credit).

## Endpoints
Auth model (all fail-closed except the two public routes) — see [Access & security model](#access--security-model).

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none (public) | health/status JSON (no secrets); a `drift` gauge (`errors`, `unposted`) + `configOk` boolean; `/` returns 404 |
| `POST /webhooks/meltwater/:token` | path token = `WEBHOOK_SHARED_SECRET` | receive a Meltwater alert (archive write retries; returns 5xx if it can't persist) |
| `GET /inspect` | **Cloudflare Access** (login) | inspection UI (`?filter=failed` shows only errored/undelivered events) |
| `GET /api/webhooks/recent` | **Cloudflare Access** | recent events as JSON |
| `POST /admin/redecode` | `Authorization: Bearer REPLAY_KEY` | re-render recent cards under the current decoding and `chat.update` the changed ones in place (non-destructive). `dryRun=1` previews; `hours=N` sets the window (default 168); capped at 40 updates/call (re-run until `remaining` is 0) |
| `POST /admin/replay` | `Authorization: Bearer REPLAY_KEY` | reparse + **repost** archived events (destructive — clears + reposts; prefer `/admin/redecode`) |
| `GET /admin/render-station?url=…` | `Authorization: Bearer REPLAY_KEY` | render a Meltwater viewer URL via Browser Rendering and return its station name (debug/verify) |
| `GET /admin/heartbeat` | `Authorization: Bearer REPLAY_KEY` | run the ingestion-stall check on demand |

## Local development
```bash
pnpm install
cp .dev.vars.example .dev.vars          # then edit the secrets
pnpm db:migrate:local                   # apply D1 migration to the local db
pnpm dev                                 # wrangler dev on http://localhost:8787

# send a sample alert (token = your WEBHOOK_SHARED_SECRET from .dev.vars):
curl -X POST --data-binary @test/sample-alert.json \
  http://localhost:8787/webhooks/meltwater/dev-secret-change-me
open "http://localhost:8787/inspect"   # /inspect is Access-gated in prod; DEV_SKIP_ACCESS=true opens it locally
```
`pnpm test` runs the unit tests; `pnpm typecheck` runs `tsc --noEmit`.

`POSTING_ENABLED` (in `wrangler.jsonc`) toggles Slack posting. Set it to `"false"` to
**pause** — the pipeline still parses, filters and renders a Block Kit **preview**
(visible in `/inspect`) without posting. Set `"true"` to go live. Note: after you un-pause,
the next reconcile tick posts any un-posted events from the last 72h (the backlog accumulated
while paused) — purge/narrow first if you don't want the catch-up.

## Reliability (self-healing)
The archive is the source of truth; the Slack channel is a derived, rebuildable projection.
- **Archive-first ingestion.** Each raw payload is written to `webhook_events` **before** any
  processing, with a short retry; if that write can't land it returns **5xx** so Meltwater retries.
- **Scheduled reconcile.** A Cron Trigger (`*/15 * * * *`, `scheduled()` in `src/index.ts`) re-runs
  the recent archive window (last 72h, excluding the last ~15 min) back through the pipeline. It's
  `seen`-aware, so already-delivered mentions are skipped as duplicates and only **un-posted
  stragglers** actually re-post/merge — a transient Slack/D1 failure self-heals within a tick or two
  without operator action. `EventLog.markProcessed` is monotonic, so re-runs never downgrade a
  delivered event's row.
- **Drift visibility.** `GET /health` reports `drift.errors` + `drift.unposted` (last 7 days);
  `/inspect?filter=failed` lists the offending events. The reconcile also `console.warn`s a summary
  (Workers observability) when a pass leaves anything still failed.
- **Manual backfill.** `POST /admin/replay` (`Authorization: Bearer REPLAY_KEY`) reprocesses the
  archive: `reset=1` rebuilds dedupe/story state, `purge=1` clears the channel first, `limit=N`
  regenerates the most recent N. Idempotent — safe to re-run. (For a format-only refresh that keeps
  reactions/threads, prefer `POST /admin/redecode`.)

## Tuning the feed
Edit `src/config/feed.config.ts`. Start lenient, watch `/inspect` on real traffic, then tighten:
- `minSourceReach` — drop small outlets ("major sources only")
- `includeMediaTypes` / `excludeMediaTypes` — kill radio/social/blog noise (set once you see the real values in `/inspect`)
- `sourceAllowlist` / `sourceBlocklist`, `allowedCountryCodes`
- `briefs[]` — each brief's `label` (the "Organisation Brief"), `keywords` (highlighted + counted), and optional `matchNames`/`channel`

> The Generic Webhook payload schema isn't publicly documented, so `src/lib/meltwater/parse.ts`
> extracts fields defensively from many candidate names. **After the first real alert, open
> `/inspect`, read the raw payload, and tighten `parse.ts` to the actual field names.**

## Broadcast station names
Radio/TV alerts (`providerType: tveyes_*`) don't carry the station in the payload — `authorName` is
either the station *or* the on-air reporter, and the real station name lives only on Meltwater's
broadcast **viewer**, which is a client-rendered SPA (so `curl` can't read it). We resolve it in two
cached steps (`src/lib/meltwater/station-resolve.ts`):

1. **Code** — follow `links.article` server-side to the `mediaView` token and read its numeric
   `Station=<code>`. Cached in D1 `broadcast_stations` by Meltwater doc id, so each clip is fetched at
   most once.
2. **Name** — map `<code>` → display name via the D1 `station_names` table (seeded in
   `migrations/0007`). On a miss, **Cloudflare Browser Rendering** (the `browser` binding) loads the
   viewer *once* — at ingestion, while the token is fresh — follows its JS redirects, reads the station
   from the page title (`"702 ABC Sydney - <program> - <time>"`), and caches `code → name`. Every later
   clip from that station then resolves for free, with no browser.

The resolved station becomes the card header and any reporter drops to the **Author** byline. Adding or
correcting a station is a one-row `INSERT` into `station_names` — **no deploy, no code change**:
```bash
npx wrangler d1 execute headwater --remote \
  --command "INSERT OR REPLACE INTO station_names (code, name) VALUES ('8645', '702 ABC Sydney')"
```
`GET /admin/render-station?url=<viewer url>` (`Authorization: Bearer REPLAY_KEY`) renders a viewer URL on demand to check
what a station resolves to. The `/admin/redecode` backfill re-applies station names to already-posted
cards from the D1 map only (it never renders), so old clips upgrade once their station is known.

## Deploy to Cloudflare
Browser Rendering needs no separate provisioning — the `browser` binding in `wrangler.jsonc` enables it
(free tier: 10 min/day). Then:
```bash
npx wrangler login
npx wrangler d1 create headwater               # paste the printed database_id into wrangler.jsonc
pnpm db:migrate:remote

# secrets (prod) — set each with `wrangler secret put <NAME>`; where to get each value:
npx wrangler secret put WEBHOOK_SHARED_SECRET   # webhook path token — generate: openssl rand -hex 32
npx wrangler secret put REPLAY_KEY              # bearer token for /admin/* — generate: openssl rand -hex 32
npx wrangler secret put SLACK_BOT_TOKEN         # xoxb-… — Slack app → OAuth & Permissions (later)
npx wrangler secret put SLACK_DEFAULT_CHANNEL   # channel id, e.g. C0123ABCD — Slack channel → Copy link
npx wrangler secret put ACCESS_TEAM_DOMAIN      # https://<team>.cloudflareaccess.com — Zero Trust → Settings
npx wrangler secret put ACCESS_AUD              # Access → Applications → your app → Application Audience (AUD) Tag

pnpm deploy                                     # → your custom domain (workers.dev is disabled)
```
The last two secrets come from the Cloudflare Access setup — see [Access & security model](#access--security-model),
which also explains why `/inspect` and `/admin/*` are **non-functional until you configure it**.

## Wire up Meltwater
Two separate steps. Registering the webhook **destination** is not enough on its own — you must also
point one or more **alerts** at it. Both live in the Meltwater app.

### a. Set up the Generic Webhook (the destination)
1. **Account → Third-party Integrations → Generic Webhook → Connect.**
2. Give it a **name** (e.g. `headwater-shac`) and paste the webhook **URL**:
   `https://<your-host>/webhooks/meltwater/<WEBHOOK_SHARED_SECRET>`
   The path token **is** the auth — it must match the Worker's `WEBHOOK_SHARED_SECRET` secret exactly.
3. **Add.** This only registers the destination — no mentions flow yet.

### b. Point alerts at the webhook (the binding)
The search → webhook binding lives under **Alerts**, not the integrations page. The destination
sends nothing until an alert names it as a delivery method.
1. Open **Alerts** (the 🔔 in the left sidebar — its own top-level item) → **Create alert**
   (or **Monitor → Views → Create Alert**). To add the webhook to an *existing* alert, open that
   alert and skip to step 4.
2. Under **Smart Alerts → Search Alerts**, use **Every Mention** — the real-time, per-article type.
   Avoid *Spike Detection* / digest types; they don't deliver each article.
3. **+ Add search** — pick the saved search(es) to forward (up to 10 per alert).
4. Under **Delivery method**, expand **Generic Webhook** and tick your connection
   (e.g. `headwater-shac`). An alert can use several methods at once — leave **Email** ticked to
   keep the email alert too, or untick it for webhook-only.
5. **Save.** Repeat for every alert/search you want in the feed.

There is **no "test" button** — Meltwater POSTs on the next matching mention. Watch `/inspect`
for the first real payload, then tighten `src/lib/meltwater/parse.ts` to the actual field names.

### c. What the Generic Webhook UI does *not* give you (read before debugging a silent feed)
The Meltwater Generic Webhook UI is deliberately minimal — a connection is only a **name + a
URL** (the *Add Generic Webhook* dialog has just `Connection name` and `Webhook link`). Once
saved it is effectively **write-only and opaque**, which makes a silent feed hard to debug:

- **The URL is masked.** The integrations list shows only `https://<host>/***`; the path token
  (`WEBHOOK_SHARED_SECRET`) is hidden and cannot be revealed.
- **No edit — only delete (✕).** To change the host *or* rotate the token you must **delete the
  connection and add a new one**. Treat the URL as immutable: if you migrate hosts (e.g.
  `*.workers.dev` → a custom domain) or rotate the secret, the old connection keeps POSTing to
  the old URL with **no error surfaced in Meltwater**.
- **No test button, no delivery log, no status.** Meltwater never shows whether a delivery
  succeeded, failed, or what HTTP status the destination returned.
- **Registering ≠ delivering.** The connection is only a *destination*; nothing flows until a
  search/alert is bound to it (§b). A freshly (re-)added connection has **no searches bound**.

**Consequence — the destination server is the only source of truth.** Where each delivery lands:

| From Meltwater | `/inspect` (D1 `webhook_events`) | CF Worker logs / `wrangler tail` | CF zone Analytics → Traffic |
|---|---|---|---|
| correct token → `200` | ✅ row logged | ✅ 200 invocation | ✅ 200 on the host |
| **wrong token → `403`** | ❌ **rejected before it's logged** | ✅ 403 invocation (path shows the bad token) | ✅ 403 on the host |
| wrong host / disabled `*.workers.dev` | ❌ | ❌ Worker never runs | ⚠️ only in *that* host's zone — a disabled `workers.dev` 404s at the edge and lands in **no** log you own |

So a **token mismatch is invisible in `/inspect`** (the 403 is rejected before storage — see
*Monitoring* below) but **is** visible in Cloudflare: a 403 POST invocation in the Worker logs /
`wrangler tail`, and a 403 on the host in the zone's Traffic analytics — where the URL path even
reveals the wrong token. Since Meltwater masks the token, **reading it off a Cloudflare 403 log is
the only way to see what token is actually registered** (or just delete + re-add with the
known-correct URL).

> The search/alert name Meltwater sends becomes the Slack **brief label** (matched against
> `matchNames` in `src/config/feed.config.ts`). A non-match still posts under `defaultBriefLabel`, so
> naming never blocks delivery — it only affects labeling.

## Wire up Slack
1. Create a Slack app → add bot scope `chat:write` (optionally `chat:write.public`) → install → copy the `xoxb-…` token.
2. Create the channel and `/invite` the bot.
3. `wrangler secret put SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL` (the channel id, e.g. `C0123ABCD`).
4. Set `"POSTING_ENABLED": "true"` in `wrangler.jsonc` and `pnpm deploy`.

## Monitoring
Two guardrails exist because a webhook-secret mismatch (or a stalled upstream) can silence the feed
with **no error** — deliveries are rejected before they're ever logged.

- **Config validation** — `GET /health` returns `configOk`, a *format* check of the runtime env:
  bare tokens vs a pasted URL (the classic footgun: putting the whole webhook URL in
  `WEBHOOK_SHARED_SECRET` instead of just the path token), an `xoxb-` bot token, a channel id or
  `#name`, and `POSTING_ENABLED` being exactly `"true"`/`"false"`. It never leaks values — only the
  `configOk` boolean is exposed. (This catches *malformed* config, not a well-formed-but-wrong value —
  that's what the heartbeat is for.)
- **Ingestion heartbeat** — an hourly cron (`triggers.crons` in `wrangler.jsonc` → `scheduled()` in
  `src/index.ts` → `src/lib/heartbeat.ts`) checks the newest `webhook_events` row **that parsed
  into a real mention** (so empty-body probes / health pings can't mask a stall) and posts a Slack
  alert if nothing has arrived within `HEARTBEAT_MAX_SILENCE_HOURS` (default 3). It de-dupes via the
  `ops_state` table so a persistent stall pages at most once per `HEARTBEAT_REALERT_HOURS`
  (default 6) and re-arms once ingestion recovers. Trigger it on demand at `GET /admin/heartbeat`
  with `Authorization: Bearer <REPLAY_KEY>`.
  - Optional tunables (non-secret — set in `wrangler.jsonc` `vars`, or as secrets):
    `HEARTBEAT_MAX_SILENCE_HOURS`, `HEARTBEAT_REALERT_HOURS`, and `SLACK_ALERT_CHANNEL`
    (the alert channel; defaults to `SLACK_DEFAULT_CHANNEL`).

## Troubleshooting: the feed went silent
Work top-down — the first item is the most common cause and the cheapest to check.

1. **Is an alert actually bound to the webhook?** ⚠️ **#1 cause.** Registering the Generic
   Webhook (§a) only creates a *destination*; each search/alert must also *deliver* to it:
   **Alerts → open every _Every Mention_ alert → Delivery method → Generic Webhook → tick your
   connection → Save.** A silent feed with a healthy `/health` is almost always this. Two traps:
   the binding lives per-alert (tick it on **all** the alerts you want, not just one), and
   **re-adding a webhook connection drops the binding**, so always re-check after a re-add.
2. **Is Meltwater pointed at the right URL?** The UI masks it to `feed.moofer.com/***` and
   can't be edited — delete + re-add only (§c). Verify it against `MELTWATER_WEBHOOK_URL` in
   `.dev.vars`. A host/token change silently orphans the old connection.
3. **Is anything reaching the Worker?** Check Cloudflare — `npx wrangler tail headwater` (live)
   or the zone's **Analytics → Traffic**. A `403` on `/webhooks/meltwater/*` = wrong/stale
   token (the path even shows it); **nothing at all** = wrong host, unbound alert, or a
   disabled `*.workers.dev`. Note a `403` is **not** in `/inspect` (rejected before logging).
4. **Is the Worker healthy?** `GET /health` → `build` (matches the last deploy?),
   `postingEnabled: true`, `configOk: true`.
5. **Are mentions arriving but not posting?** Open `GET /inspect` (behind Cloudflare Access) —
   read each event's `decision`/`reason` (a filter `dropped` it, `duplicate`, or `slack_error:*`).
6. **Heartbeat quiet when it shouldn't be?** It measures the newest `webhook_events` row that
   parsed into a real *mention* (not raw receipts), so probes/health-pings can't mask a stall.
   It de-dupes via `ops_state`, so a persistent stall pages at most once per re-alert window.

## Access & security model
Every endpoint except the two public ones is **fail-closed** — enforced *in the Worker*, so it stays
shut even if Cloudflare Access is later disabled or misconfigured. None of this is a secret to hide:
security rests on the tokens below and on *who your Access policy admits*, not on obscuring the method.

| Route(s) | Guard | Why it fails closed |
|---|---|---|
| `POST /webhooks/meltwater/:token` | path token = `WEBHOOK_SHARED_SECRET` (timing-safe) | wrong token → 403 |
| `GET /inspect`, `GET /api/webhooks/recent` | **Cloudflare Access** login **+** the Worker verifies the injected `Cf-Access-Jwt-Assertion` JWT (signature via your team's JWKS, plus issuer + AUD) | missing/invalid JWT → 403, even if Access is turned off |
| `/admin/*` | `Authorization: Bearer REPLAY_KEY` (timing-safe) | wrong/absent bearer → 403 |
| `GET /health` | public | metadata only — no secret values |

Plus **`workers_dev: false`** (reachable only on the custom domain, so there's no workers.dev URL to
sidestep Access) and a `Referrer-Policy: no-referrer` on every response.

### Set up Cloudflare Access — required; `/inspect` + `/api` are non-functional without it
1. Cloudflare **Zero Trust → Access → Applications → Add → Self-hosted**.
2. **Destinations:** your host with path `/inspect`, and again with path `/api`. Leave `/admin`,
   `/webhooks`, and `/health` uncovered (admin uses the bearer token; the others must stay open).
3. **Policy:** Allow → Include → the emails/identities you trust (built-in One-time PIN needs no SSO).
4. Give the Worker the app's two identifiers (not secrets, but keep them out of this public repo — set
   via `wrangler secret` / `.dev.vars`, per [.dev.vars.example](.dev.vars.example)):
   - `ACCESS_TEAM_DOMAIN` — Zero Trust → **Settings → Team domain**, as `https://<team>.cloudflareaccess.com`
   - `ACCESS_AUD` — Access → Applications → your app → **Application Audience (AUD) Tag**

Call an admin endpoint from a script (bearer, not a URL key):
```bash
curl -H "Authorization: Bearer $REPLAY_KEY" "https://<host>/admin/redecode?dryRun=1"
```
Local `wrangler dev` has no Access in front of it, so set `DEV_SKIP_ACCESS=true` in `.dev.vars` to open
`/inspect` locally. **Never** set that in prod.

## Security & privacy
- **No secrets in the repo** (it's public). Real secrets live only in `.dev.vars` (gitignored) and
  `wrangler secret`; `wrangler.jsonc` carries only identifiers (the D1 `database_id`, the route).
  Rotate `WEBHOOK_SHARED_SECRET`, `REPLAY_KEY`, and the Slack token if ever exposed.
- Endpoint auth is the [Access & security model](#access--security-model) above — fail-closed except
  `/health` and the webhook.
- `src/config/feed.config.ts` ships with **generic example briefs** — replace them with your own.
