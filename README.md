# Headwater

**Headwater** is a Cloudflare Worker that rebuilds a **Streem-style** media-monitoring feed in Slack
from Meltwater's **Generic Webhook** (Smart Alerts). It receives each alert, filters to a
curated signal, reformats it into a tight Slack Block Kit message (with link-unfurling
disabled), and posts it — replacing Meltwater's noisy built-in Slack feed.

- **Ingestion:** Meltwater Generic Webhook → `POST /webhooks/meltwater/:token`
- **Pipeline:** `parse → filter → dedupe → merge (syndication + broadcast near-dup) → post` (`src/lib/process.ts`)
- **Streem-style output:** source + icon, bold linked headline, snippet with matched keywords as `code` pills (or a `Mentions: kw (n)` line), and an **Author | Organisation Brief** footer. Slack auto-unfurl is disabled.
- **Deduplication:** three layers — exact (`seen_mentions`), same-headline **syndication**, and broadcast **shared-phrase near-duplicate** (SimHash + verbatim run) — collapse a story to one message that lists every outlet (`📡 Also in: …`) via `chat.update`. See [Deduplication](#deduplication).
- **Tuning surface:** `src/config/feed.config.ts` (briefs, keywords, source allow/block, reach, media types)
- **Broadcast station names:** radio/TV alerts don't carry the station — it's resolved from Meltwater's JS viewer and cached in D1 (see [Broadcast station names](#broadcast-station-names))
- **Persistence (D1):** `webhook_events` (raw + parsed + decision, powers `/inspect`), `seen_mentions` (exact dedupe), `stories` (one row per story = one Slack message: `slack_ts` + `channel`, outlet list, `simhash`/`media_type` for broadcast near-dup, `render_hash` for the redecode backfill), `broadcast_stations` + `station_names` (radio/TV station resolution), `ops_state` (heartbeat bookkeeping)
- **Cloudflare resources (all required to bring the system up):** **Workers** (the app + `scheduled()` cron triggers), **D1** (all persistence above), **Queues** (`INGEST_QUEUE` — the webhook enqueues each event id; the `queue()` consumer drains it one-at-a-time so ingestion is serial and the near-dup lookup never races — **needs the Workers Paid plan**), a **Durable Object** (`STATION_RENDERER` — the single serial station-render drainer; SQLite-backed, free-plan-ok), **Browser Rendering** (the `browser` binding — headless Chromium, used *only* for first-time station-name resolution; a few seconds per new station, well within the free 10 min/day), and **Cloudflare Access** (Zero Trust — gates `/inspect`+`/api`; see [Access & security model](#access--security-model)). Provisioning for each is in [Deploy to Cloudflare](#deploy-to-cloudflare).
- **Inspect:** `GET /inspect` (Cloudflare Access) — recent events, raw payload, filter decision + reason, Block Kit preview
- **Monitoring:** `GET /health` is the single assertion point — it validates the runtime config (`configOk`) and **fails closed (503)** on a dead database, a stopped cron, an unprocessed backlog, a stalled feed or unhealable drift, each a separate boolean in `checks` (`src/lib/health.ts`); an hourly cron **heartbeat** also alerts Slack if ingestion goes quiet (`src/lib/heartbeat.ts`)

Deferred (not built): RSS-poll fallback and the native REST API path. Print is excluded (no plan credit).

## Endpoints
Auth model (all fail-closed except the two public routes) — see [Access & security model](#access--security-model).

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none (public) | health/status JSON (no secrets): per-fault `checks`, a `drift` gauge (`errors`, `unposted`), `configOk`; **503 when any check fails**; `/` returns 404 |
| `POST /webhooks/meltwater/:token` | path token = `WEBHOOK_SHARED_SECRET` | receive a Meltwater alert (archive write retries; returns 5xx if it can't persist) |
| `GET /inspect` | **Cloudflare Access** (login) | inspection UI (`?filter=failed` shows only errored/undelivered events) |
| `GET /api/webhooks/recent` | **Cloudflare Access** | recent events as JSON |
| `POST /admin/redecode` | `Authorization: Bearer REPLAY_KEY` | re-render recent cards under the current decoding and `chat.update` the changed ones in place (non-destructive). `dryRun=1` previews; `hours=N` sets the window (default 168); capped at 40 updates/call (re-run until `remaining` is 0) |
| `POST /admin/coalesce` | `Authorization: Bearer REPLAY_KEY` | coalesce broadcast duplicates that posted as separate messages **in place** — edit the oldest, delete the rest (non-destructive to the survivor). `dryRun=1` previews; `hours=N`/`all=1` set the window; capped at 40 Slack calls/call (re-run until `remaining` is 0). See [Deduplication](#deduplication) |
| `POST /admin/repair-snippets` | `Authorization: Bearer REPLAY_KEY` | rewrite snippets Meltwater cut mid-sentence at **either edge** — a severed sentence mark is dropped (`". The premier…"`), severed clause punctuation and an unmarked lowercase/digit start become a leading `…`, an unmarked tail gets a trailing `…`, and their literal `...` is normalised to the same glyph (see `tidySnippet`) — in stories already stored, in **both** `primary_mention_json` and each outlet's copy, and `chat.update` any card whose rendering changes. Unlike `/admin/redecode` this fixes outlet-led cards and persists data-only repairs, and it never bumps `updated_at`. `dryRun=1` previews; `hours=N` (default 720); capped at 40 updates/call |
| `POST /admin/replay` | `Authorization: Bearer REPLAY_KEY` | reparse + **repost** archived events (destructive — clears + reposts; prefer `/admin/redecode`) |
| `POST /admin/test-post` | `Authorization: Bearer REPLAY_KEY` | post one synthetic card per brief to wherever `/inspect/routing` sends it, to verify routing without waiting for a Meltwater delivery. **Dry run by default** — `post=1` actually posts; `brief=<id>` limits it to one. Test cards are never stored, so they never merge with a real story. `cleanup=1` deletes them again (matched on the title marker, so it can only ever remove test cards) |
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
  reactions/threads, prefer `POST /admin/redecode`; to collapse already-posted broadcast duplicates in
  place, `POST /admin/coalesce` — see [Deduplication](#deduplication).)

## Tuning the feed
Edit `src/config/feed.config.ts`. Start lenient, watch `/inspect` on real traffic, then tighten:
- `minSourceReach` — drop small outlets ("major sources only")
- `includeMediaTypes` / `excludeMediaTypes` — kill radio/social/blog noise (set once you see the real values in `/inspect`)
- `sourceAllowlist` / `sourceBlocklist`, `allowedCountryCodes`
- `briefs[]` — each brief's `label` (the "Organisation Brief"), `keywords` (highlighted + counted), and optional `matchNames`. Which Slack channel(s) a brief posts to is **not** in this file — it's edited at `/inspect/routing` (see below)
- `nearDuplicate` — broadcast shared-phrase merge thresholds (SimHash Hamming, phrase overlap, verbatim-run length, air-time gap, media types); see [Deduplication](#deduplication)

> The Generic Webhook payload schema isn't publicly documented, so `src/lib/meltwater/parse.ts`
> extracts fields defensively from many candidate names. **After the first real alert, open
> `/inspect`, read the raw payload, and tighten `parse.ts` to the actual field names.**

## Deduplication
The feed collapses repeats so **one *story* is one Slack message**, however many mentions Meltwater
sends for it. Three layers run in `src/lib/process.ts`, cheapest first:

1. **Exact (idempotency).** Every kept mention is keyed by `sha-256(briefId | url)` — or
   `sourceName|title` when it has no url — in the `seen_mentions` table; a mention already seen is
   dropped with no Slack call. The key is **brief-scoped**, so the *same* article matched by a
   *different* brief isn't silently swallowed — it flows to the merge path and is recorded as "also
   matched". This is also what makes the reconcile/replay reruns idempotent.
2. **Syndication (same headline).** A wire story republished across many outlets shares its headline,
   so a `sha-256` of the **normalized** title (`src/lib/story.ts`) is the *story key*. A new mention
   whose story key already exists **within 72h** folds into that story instead of posting again.
3. **Broadcast near-duplicate (shared phrase).** Machine-transcribed radio/TV airs the *same reading*
   across dozens of stations, but each capture has a different `program — <air-time>` title and a
   slightly different speech-to-text, so layers 1–2 miss it. Two transcripts are judged the same story
   by a shared-phrase test (`src/lib/nearmatch.ts` + `src/lib/simhash.ts`; thresholds in
   `feedConfig.nearDuplicate`): an all-but-identical 64-bit **SimHash** (Hamming ≤ 3) is a fast accept;
   otherwise they must clear **both** k-gram *containment* (overlap coefficient ≥ 0.25 — min-based, so
   a short ~300-char snippet fully inside a longer transcript still scores high) **and** a *contiguous
   verbatim run* (≥ 12 words, which rejects coincidental stock phrases). Two hard guards gate every
   candidate first: **same media type** (radio never folds into TV) and **air-times within 3h** (a
   re-air days later is a new story). The predicate lives in `src/lib/neardup.ts` and is shared with the
   backfill below, so ingestion and cleanup judge duplicates identically.

**A caught duplicate never posts a new message** — it folds into the existing story's card via
`chat.update`: the outlet is appended (`📡 Also in: …`, up to 8 shown), the footer's single reach
becomes an outlet count + combined reach, and any extra matching brief is noted. The durable handle is
the `stories` row (`slack_ts` + `channel`), keyed by the *story*, not the mention — one message can
represent many mentions across many `webhook_events`. Only mentions that actually posted/merged are
marked `seen`, so a failed Slack call leaves the mention un-seen and the next reconcile retries it.

### Coalescing historical duplicates
Broadcast near-dup detection landed after some duplicates had already posted as separate messages.
`POST /admin/coalesce` (`Authorization: Bearer REPLAY_KEY`) cleans those up **in place**: it re-clusters
recent broadcast stories with the *same* near-dup predicate — **star-clustered around the oldest**, so a
non-transitive match can't chain unrelated stories together — then per group **edits the oldest message**
to list every outlet and **deletes the duplicates**. Reactions/threads on the survivor are preserved
(unlike `/admin/replay`, which wipes + reposts). While merging it **re-resolves every station** (headline
*and* each outlet) from the current D1 station map — a member's raw payload, or the docId embedded in an
already-merged outlet's tracking url — so cards show real station names instead of a presenter byline
frozen at ingestion. `dryRun=1` previews the groups (no Slack/D1 writes); `hours=N` bounds the window
(default 168) or `all=1` scans from day 0; capped at 40 Slack calls/invocation — re-run until
`remaining` is 0. Idempotent.

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
Browser Rendering and the Durable Object need no separate provisioning — the `browser` binding and the
`durable_objects` + `migrations` blocks in `wrangler.jsonc` enable them on `deploy` (Browser Rendering
free tier: 10 min/day). **Queues, however, must be created first and require the Workers Paid plan.** Then:
```bash
npx wrangler login
npx wrangler d1 create headwater               # paste the printed database_id into wrangler.jsonc
pnpm db:migrate:remote

# Queues (Workers Paid) — create both before the first deploy; the queues.producers/consumers in
# wrangler.jsonc reference them by name. The DLQ is the parking lot for messages that exhaust retries.
npx wrangler queues create headwater-ingest
npx wrangler queues create headwater-ingest-dlq

# secrets (prod) — set each with `wrangler secret put <NAME>`; where to get each value:
npx wrangler secret put WEBHOOK_SHARED_SECRET   # webhook path token — generate: openssl rand -hex 32
npx wrangler secret put REPLAY_KEY              # bearer token for /admin/* — generate: openssl rand -hex 32
npx wrangler secret put SLACK_BOT_TOKEN         # xoxb-… — Slack app → OAuth & Permissions (later)
npx wrangler secret put SLACK_DEFAULT_CHANNEL   # channel id, e.g. C0123ABCD — Slack channel → Copy link
npx wrangler secret put SLACK_SIGNING_SECRET    # Slack app → Basic Information — enables the /digest slash command
npx wrangler secret put RESEND_API_KEY          # re_… — resend.com → API Keys (digest email; with DIGEST_FROM below)
npx wrangler secret put DIGEST_FROM             # From address on a Resend-verified domain, e.g. digest@example.org
npx wrangler secret put ACCESS_TEAM_DOMAIN      # https://<team>.cloudflareaccess.com — Zero Trust → Settings
npx wrangler secret put ACCESS_AUD              # Access → Applications → your app → Application Audience (AUD) Tag

pnpm run deploy                                 # → your custom domain (workers.dev is disabled)
```
The last two secrets come from the Cloudflare Access setup — see [Access & security model](#access--security-model),
which also explains why `/inspect` and `/admin/*` are **non-functional until you configure it**.

### Configuration reference

Every environment variable the Worker reads. **Secrets** go in `.dev.vars` locally and
`wrangler secret put <NAME>` in prod — never in `wrangler.jsonc`, which is committed. **Vars** are
non-secret and live in `wrangler.jsonc` under `vars` (or as a secret if you prefer).

`GET /health` returns `configOk`, a format check over most of these — see [Monitoring](#monitoring).
It reports names and reasons only, never values.

#### Bindings (declared in `wrangler.jsonc`, not set as secrets)

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 | `webhook_events`, `stories`, `seen_mentions`, `ops_state` — see `migrations/` |
| `INGEST_QUEUE` | Queue | Sequential ingestion (`max_concurrency: 1`). Absent → the handler falls back to the in-request `waitUntil` path |
| `STATION_RENDERER` | Durable Object | Serial broadcast-station render drainer |
| `BROWSER` | Browser Rendering | Resolves station names from the JS-rendered Meltwater viewer; launched only by the DO |

#### Core — the Worker will not function without these

| Name | Kind | Purpose |
|---|---|---|
| `WEBHOOK_SHARED_SECRET` | secret | Path token for `POST /webhooks/meltwater/:token`. The token **is** the auth. Generate: `openssl rand -hex 32` |
| `REPLAY_KEY` | secret | Bearer token guarding every `/admin/*` route. Generate: `openssl rand -hex 32` |
| `SLACK_BOT_TOKEN` | secret | `xoxb-…` bot token with `chat:write` |
| `SLACK_DEFAULT_CHANNEL` | secret | Channel id (`C0123ABCD`) or `#name` |
| `POSTING_ENABLED` | var | Strict `"true"` to post to Slack. Anything else pauses posting (the pipeline still previews in `/inspect`) |

#### Cloudflare Access — `/inspect` and `/api` are non-functional without these

| Name | Kind | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | secret | `https://<team>.cloudflareaccess.com` — Zero Trust → Settings |
| `ACCESS_AUD` | secret | Application Audience (AUD) tag for the Access app |
| `DEV_SKIP_ACCESS` | **local only** | `"true"` in `.dev.vars` bypasses the Access check, because `wrangler dev` has no Access in front of it. Never set in `wrangler.jsonc` or prod |

#### Ingestion heartbeat — all optional, sensible defaults

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `HEARTBEAT_MAX_SILENCE_HOURS` | var | *16 weekday / 24 weekend* | Stall threshold. Unset = the measured time-of-week default; setting it overrides both days with one flat value |
| `HEARTBEAT_REALERT_HOURS` | var | `6` | While a stall persists, re-alert at most this often |
| `SLACK_ALERT_CHANNEL` | var | `SLACK_DEFAULT_CHANNEL` | Channel for heartbeat alerts |

#### Daily digest email — see [Daily digest email](#daily-digest-email)

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `DIGEST_ENABLED` | var | yes | Strict `"true"` to actually send. Anything else = no mail is ever sent |
| `RESEND_API_KEY` | secret | yes | Resend API key (`re_…`) |
| `DIGEST_FROM` | secret | yes | From address on a Resend-verified domain, e.g. `digest@news.example.org` |
| `SLACK_SIGNING_SECRET` | secret | for `/digest` | Slack app Signing Secret; verifies the slash command on `POST /slack/commands` |
| `DIGEST_FROM_NAME` | var | no (`Headwater`) | Display name on the From header |
| `DIGEST_REPLY_TO` | var | no | Set this if `DIGEST_FROM` isn't a real mailbox, so replies don't bounce |
| `DIGEST_SLACK_URL` | var | no | Slack channel link for the digest footer |

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
1. Create a Slack app → add bot scopes `chat:write` (optionally `chat:write.public`),
   `channels:read` and `groups:read` (the channel picker on `/inspect/routing` calls
   `users.conversations` over public + private channels), `channels:history` and `groups:history`
   (`/admin/replay` and `/admin/orphans` read `conversations.history` to find the bot's own cards),
   plus `users:read` and `users:read.email`
   (the `/digest` slash command reads the caller's profile email + time zone) → install → copy the
   `xoxb-…` token.
2. Create the channel and `/invite` the bot. The picker only offers channels the bot is a member of.
3. `wrangler secret put SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL` (the channel id, e.g. `C0123ABCD`).
4. Set `"POSTING_ENABLED": "true"` in `wrangler.jsonc` and `pnpm run deploy`.

> Adding scopes to an already-installed app needs **Reinstall to workspace** (OAuth & Permissions).
> Until then `/inspect/routing` shows a `missing_scope` notice instead of the channel columns and
> `/digest subscribe` explains which scope is missing; posting is unaffected.

### The `/digest` slash command
Users manage their own daily-digest subscription from Slack — see [Daily digest email](#daily-digest-email).
1. Slack app → **Slash Commands** → Create: command `/digest`, Request URL
   `https://<your custom host>/slack/commands` (the `workers.dev` URL is disabled — see the
   operational log in `CLAUDE.md`), usage hint `subscribe [time] | unsubscribe | status`.
2. Slack app → **Basic Information** → App Credentials → copy the **Signing Secret** →
   `wrangler secret put SLACK_SIGNING_SECRET`. Every inbound command is HMAC-verified against it
   (`src/lib/slack/verify.ts`) before the body is parsed; until it is set the route answers 503.
3. Reinstall the app if you added the `users:read*` scopes in the same change.

### Routing briefs to channels — `/inspect/routing`
Each brief fans out to one or more Slack channels. The matrix (rows = briefs, columns = the channels
the bot is in) is stored in D1 (`ops_state.routing`), so changing it needs **no redeploy** and no
channel id ever enters this repo.

A tick means "this channel receives this brief" — that is the whole rule. Two states look similar and
are not: a brief that has **never been routed** posts to `SLACK_DEFAULT_CHANNEL` (its default-column
tick renders greyed, and saving makes it explicit), whereas a brief saved with **every box unticked**
is *muted* and posts nowhere. So a never-saved matrix reproduces the old single-channel behaviour
exactly, while unticking a row is a deliberate off switch. Muted mentions are still recorded as
`dropped` in `/inspect` (reason `muted: no channel routed for this brief`) and `/health` raises a
`routing.muted` warning, so a muted brief can't be mistaken for a dead feed.

To check routing without waiting for a delivery — and for a brief whose Meltwater search is quiet or
not yet bound, this is the only way to check at all:

```bash
# Dry run (default): report where each brief WOULD go, post nothing.
curl -fsS -X POST -H "Authorization: Bearer $REPLAY_KEY" https://<your-host>/admin/test-post | jq

# Actually post, one brief only.
curl -fsS -X POST -H "Authorization: Bearer $REPLAY_KEY" \
  "https://<your-host>/admin/test-post?post=1&brief=vic-state" | jq
```

Test cards carry no `stories`/`seen_mentions` row, so they never merge with a real article and the
call is repeatable. That also makes them orphans by construction — so clean them up with
`?cleanup=1`, **not** `/admin/orphans`, which deletes every card lacking a story row and would take
real ones with them:

```bash
# Dry run: list the test cards that would be deleted.
curl -fsS -X POST -H "Authorization: Bearer $REPLAY_KEY" \
  "https://<your-host>/admin/test-post?cleanup=1" | jq

# Delete them (add &tag=<tag from the post response> to clear just one run).
curl -fsS -X POST -H "Authorization: Bearer $REPLAY_KEY" \
  "https://<your-host>/admin/test-post?cleanup=1&post=1" | jq
```

Cleanup matches on the title marker, so it can only ever remove test cards.

Fanout is **per channel all the way down**: `stories.story_key` is
`"<channel>|<sha256(title)>|<created_at>"`, so the same headline routed to two channels is two
independent cards that merge and coalesce separately. `/health` reports `channels` (a count only).
Migrations `0010_stories_channel_key.sql` and `0011_stories_instance_key.sql` re-key older rows in
place and are both idempotent.

The trailing `created_at` identifies one posted card. Merging looks up the newest row matching the
`"<channel>|<sha256(title)>"` prefix within the syndication window; anything older is left as
history. Without it the key was eternal while the lookup was windowed, so a headline recurring after
72h posted a fresh card, collided on INSERT, and `ON CONFLICT DO UPDATE` repointed the row at the new
message — orphaning the old card. That was 16 of the 17 orphans swept on 2026-09-08.

## Daily digest email
A once-a-day email of the stories from the last 24 hours, rendered as the same cards the Slack feed
posts. `GET /digest` previews it (Access-gated; `?days=7`, `?text=1` for the plain-text part), and
`src/ui/email.ts` is the email twin of the `/inspect` card renderer — same `SlackAttachment`, email-safe
markup (nested tables, inline styles) because Gmail and Outlook strip `<style>` blocks and positioned
pseudo-elements.

**Delivery.** Mail goes out through **Resend** (`src/lib/mailer.ts`; `RESEND_API_KEY`, `DIGEST_FROM`
on a Resend-verified domain). Cloudflare Email Sending was ruled out because it needs Workers Paid on
the account that owns the sending domain, which is not necessarily the account running this Worker.

**Subscribing — from Slack.** Recipients are not configured in env; each person subscribes themselves
with the `/digest` slash command (setup: [The `/digest` slash command](#the-digest-slash-command)):

| Command | Effect |
|---|---|
| `/digest subscribe` | Subscribe at **8:00am** in your Slack profile's time zone |
| `/digest subscribe 7:30` / `6am` / `19:15` | Subscribe (or change the time). Rounded to the nearest 15 minutes |
| `/digest unsubscribe` | Stop receiving it |
| `/digest status` (or bare `/digest`) | Show your address, time, zone, last and next send |
| `/digest who` | The whole roster — a Block Kit table of who's subscribed, at what local time. Addresses are masked (`s•••@example.org`). Deliberately left out of the command's usage hint: not secret, just not worth advertising. `/digest who plain` renders it as plain text instead |

The address is always the caller's **Slack profile email** (`users.info`), so nobody can point the digest
at an address they don't own; the zone is the profile's `tz`. Subscriptions live in D1
(`digest_subscribers`, migration 0012). `GET /admin/digest-subscribers` (bearer `REPLAY_KEY`) lists
them and is the one place **full** addresses surface (`/digest who` masks them); `/health` reports the
count only.

**Schedule.** The quarter-hour cron (`*/15 * * * *`) runs `src/lib/digestSend.ts`, which checks every
subscriber against *their own* zone's clock: due once their local time has passed the chosen slot and
nothing has gone out on their local day. Because the check is "has passed" rather than "equals", a late
tick, an outage or a daylight-saving gap delivers late rather than never (subscribing after today's slot
pre-marks today, so a new subscription never fires immediately). No UTC offset arithmetic anywhere, so
DST needs no special-casing. All subscribers due on the same tick share one 24-hour story window, and
the email is rendered once per distinct zone.

**Send-once.** Each subscriber's local calendar day of the last send is recorded on their row, written
only *after* the mail API accepts the message — so a failed send retries on the next tick and a cron
retry never double-sends. Resend's `Idempotency-Key` (user + day + slot) backstops the marker.

**Testing.** `POST /admin/digest-send` (`Authorization: Bearer REPLAY_KEY`) runs the same code path:
- `?dryRun=1` — build and render, report who is due and the story count, send **nothing**
  (ignores `DIGEST_ENABLED`)
- `?force=1` — bypass every subscriber's time-of-day gate for a real send

`force` deliberately does **not** bypass the already-sent-today guard: testing must never be able to
double-send a real digest.

## Monitoring
Two guardrails exist because a webhook-secret mismatch (or a stalled upstream) can silence the feed
with **no error** — deliveries are rejected before they're ever logged.

- **Config validation** — `GET /health` returns `configOk`, a *format* check of the runtime env:
  bare tokens vs a pasted URL (the classic footgun: putting the whole webhook URL in
  `WEBHOOK_SHARED_SECRET` instead of just the path token), an `xoxb-` bot token, a channel id or
  `#name`, and `POSTING_ENABLED` being exactly `"true"`/`"false"`. It never leaks values — only the
  `configOk` boolean is exposed. (This catches *malformed* config, not a well-formed-but-wrong value —
  that's what the heartbeat is for.)
- **Failing closed** — `/health` returns **503** when any check in its `checks` object fails: the
  database is unreadable, either cron has stopped ticking (`ops_state` markers, 2 h / 45 min), events
  arrived but never processed, the feed has gone quiet, or a failure is older than the window
  reconcile could heal it in. An external uptime check that requires a 2xx therefore covers all of
  them; the body keeps its full shape (including `configOk`) so a keyword assertion stays meaningful.
  Read `checks` first when it goes red — one alarm means the diagnosis lives in the body. Predicates
  are pure and unit-tested (`src/lib/health.ts`); `null` (a marker never written, an empty archive)
  reads healthy, because only *staleness* is a signal.
- **Ingestion heartbeat** — an hourly cron (`triggers.crons` in `wrangler.jsonc` → `scheduled()` in
  `src/index.ts` → `src/lib/heartbeat.ts`) checks the newest `webhook_events` row **that parsed
  into a real mention** (so empty-body probes / health pings can't mask a stall) and posts a Slack
  alert if nothing has arrived within the stall threshold. It de-dupes via the `ops_state` table so a
  persistent stall pages at most once per `HEARTBEAT_REALERT_HOURS` (default 6) and re-arms once
  ingestion recovers. Trigger it on demand at `GET /admin/heartbeat` with
  `Authorization: Bearer <REPLAY_KEY>`.
  - **The threshold is time-of-week aware: 16 h on a weekday, 24 h at the weekend** (Melbourne local
    day), and it is the *same* predicate `/health` asserts on, so the two can never disagree.
    Measured over 2,618 mentions across 66 days: every gap of 10 h or more fell on a Sat/Sun, the
    weekday maximum was 8.8 h and the weekend maximum 20.3 h. Setting
    `HEARTBEAT_MAX_SILENCE_HOURS` overrides both days with one flat value.
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
2. **Is Meltwater pointed at the right URL?** The UI masks it to `<your-host>/***` and
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
