# Agent notes

This is a **Cloudflare Worker** (Hono + D1), not a Next.js app. It receives Meltwater
Generic Webhook alerts and reposts them to Slack as tidy, filtered messages.

**Product framing:** the goal is a *Streem-like* Slack channel for a **Meltwater** feed.
"Streem" is a separate media-monitoring product we only emulate **visually** — it is **not** a
data source and is **not** connected to Meltwater. Don't conflate the two.

**Real payload shape:** production Meltwater alerts arrive as the flat **"Every Mention"** webhook
— `title`, `text` (snippet), `authorName` (outlet, occasionally a byline), `source` (the brief /
saved-search name), `providerType` (medium; `tveyes_radio` = radio), `statusLine` (reach +
sentiment as emoji text), `links.article` (Meltwater licensed/tracking link — keep it), `keywords`
(comma string). The structured `documents[]` shape also parses but is only used for synthetic
tests. Parser: `src/lib/meltwater/parse.ts`. Capture real samples via `/inspect` (raw payloads are
archived verbatim in `webhook_events.raw_json`, so the feed can be reparsed/backfilled).

- Entry point: `src/index.ts` (Hono routes). Pipeline: `src/lib/process.ts`.
- Tuning surface: `src/config/feed.config.ts` (briefs, keywords, source filters).
- Persistence: D1 (`migrations/`), accessed via `src/lib/store/*` and `src/lib/story.ts`.
- Local dev: `pnpm dev` (wrangler), `pnpm test` (vitest), `pnpm typecheck` (tsc).
- Deploy: `pnpm deploy`. Secrets via `.dev.vars` (local) / `wrangler secret put` (prod) — never commit real secrets.

See `README.md` for setup, config, and deploy details.
