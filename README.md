# meltwater-feed

A Cloudflare Worker that rebuilds a **Streem-style** media-monitoring feed in Slack from
Meltwater's **Generic Webhook** (Smart Alerts). It receives each alert, filters to a
curated signal, reformats it into a tight Slack Block Kit message (with link-unfurling
disabled), and posts it — replacing Meltwater's noisy built-in Slack feed.

- **Ingestion:** Meltwater Generic Webhook → `POST /webhooks/meltwater/:token`
- **Pipeline:** `parse → filter → dedupe → syndication-merge → post` (`src/lib/process.ts`)
- **Streem-style output:** source + icon, bold linked headline, snippet with matched keywords as `code` pills (or a `Mentions: kw (n)` line), and an **Author | Organisation Brief** footer. Slack auto-unfurl is disabled.
- **Syndication de-dup:** the same wire story across many outlets collapses into one message that lists every outlet (`📡 Also in: …`) — via `chat.update`.
- **Tuning surface:** `src/config/feed.config.ts` (briefs, keywords, source allow/block, reach, media types)
- **Persistence (D1):** `webhook_events` (raw + parsed + decision, powers `/inspect`), `seen_mentions` (dedupe), `stories` (syndication tracking)
- **Inspect:** `GET /inspect?key=…` — recent events, raw payload, filter decision + reason, Block Kit preview

Deferred (not built): RSS-poll fallback and the native REST API path. Print is excluded (no plan credit).

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | health/status JSON (no secrets); `/` returns 404 |
| `POST /webhooks/meltwater/:token` | path token = `WEBHOOK_SHARED_SECRET` | receive a Meltwater alert |
| `GET /inspect?key=…` | `key` = `INSPECT_KEY` | inspection UI |
| `GET /api/webhooks/recent?key=…` | `key` = `INSPECT_KEY` | recent events as JSON |

## Local development
```bash
pnpm install
cp .dev.vars.example .dev.vars          # then edit the secrets
pnpm db:migrate:local                   # apply D1 migration to the local db
pnpm dev                                 # wrangler dev on http://localhost:8787

# send a sample alert:
curl -X POST --data-binary @test/sample-alert.json \
  http://localhost:8787/webhooks/meltwater/dev-secret-change-me
open "http://localhost:8787/inspect?key=dev-inspect-change-me"
```
`pnpm test` runs the unit tests; `pnpm typecheck` runs `tsc --noEmit`.

`POSTING_ENABLED` (in `wrangler.jsonc`) toggles Slack posting. Set it to `"false"` to
**pause** — the pipeline still parses, filters and renders a Block Kit **preview**
(visible in `/inspect`) without posting. Set `"true"` to go live.

## Tuning the feed
Edit `src/config/feed.config.ts`. Start lenient, watch `/inspect` on real traffic, then tighten:
- `minSourceReach` — drop small outlets ("major sources only")
- `includeMediaTypes` / `excludeMediaTypes` — kill radio/social/blog noise (set once you see the real values in `/inspect`)
- `sourceAllowlist` / `sourceBlocklist`, `allowedCountryCodes`
- `briefs[]` — each brief's `label` (the "Organisation Brief"), `keywords` (highlighted + counted), and optional `matchNames`/`channel`

> The Generic Webhook payload schema isn't publicly documented, so `src/lib/meltwater/parse.ts`
> extracts fields defensively from many candidate names. **After the first real alert, open
> `/inspect`, read the raw payload, and tighten `parse.ts` to the actual field names.**

## Deploy to Cloudflare
```bash
npx wrangler login
npx wrangler d1 create meltwater_feed          # paste the printed database_id into wrangler.jsonc
pnpm db:migrate:remote

# secrets (prod):
npx wrangler secret put WEBHOOK_SHARED_SECRET   # long random string
npx wrangler secret put INSPECT_KEY
npx wrangler secret put SLACK_BOT_TOKEN          # xoxb-… (later)
npx wrangler secret put SLACK_DEFAULT_CHANNEL    # e.g. C0123ABCD (later)

pnpm deploy                                      # → https://meltwater-feed.<subdomain>.workers.dev
```
Gate `/inspect` with **Cloudflare Access** in prod for real protection (the `?key=` is a minimal fallback).

## Wire up Meltwater
Two separate steps. Registering the webhook **destination** is not enough on its own — you must also
point one or more **alerts** at it. Both live in the Meltwater app.

### a. Set up the Generic Webhook (the destination)
1. **Account → Third-party Integrations → Generic Webhook → Connect.**
2. Give it a **name** (e.g. `meltwater-feed-shac`) and paste the webhook **URL**:
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
   (e.g. `meltwater-feed-shac`). An alert can use several methods at once — leave **Email** ticked to
   keep the email alert too, or untick it for webhook-only.
5. **Save.** Repeat for every alert/search you want in the feed.

There is **no "test" button** — Meltwater POSTs on the next matching mention. Watch `/inspect?key=…`
for the first real payload, then tighten `src/lib/meltwater/parse.ts` to the actual field names.

> The search/alert name Meltwater sends becomes the Slack **brief label** (matched against
> `matchNames` in `src/config/feed.config.ts`). A non-match still posts under `defaultBriefLabel`, so
> naming never blocks delivery — it only affects labeling.

## Wire up Slack
1. Create a Slack app → add bot scope `chat:write` (optionally `chat:write.public`) → install → copy the `xoxb-…` token.
2. Create the channel and `/invite` the bot.
3. `wrangler secret put SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL` (the channel id, e.g. `C0123ABCD`).
4. Set `"POSTING_ENABLED": "true"` in `wrangler.jsonc` and `pnpm deploy`.

## Security & privacy
- **No secrets in the repo.** Real secrets live only in `.dev.vars` (gitignored) and Cloudflare
  secrets. `wrangler.jsonc` contains a D1 `database_id` (an identifier, not a credential) and your
  Worker route. Rotate the webhook/inspect secrets and Slack token if they're ever exposed.
- The webhook is guarded by an unguessable path token; `/inspect` and `/api/webhooks/*` by `INSPECT_KEY`.
  For real protection on `/inspect`, put **Cloudflare Access** in front of it.
- `src/config/feed.config.ts` ships with **generic example briefs** — replace them with your own.
