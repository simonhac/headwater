# Agent notes

This is a **Cloudflare Worker** (Hono + D1), not a Next.js app. It receives Meltwater
Generic Webhook alerts and reposts them to Slack as tidy, filtered messages.

- Entry point: `src/index.ts` (Hono routes). Pipeline: `src/lib/process.ts`.
- Tuning surface: `src/config/feed.config.ts` (briefs, keywords, source filters).
- Persistence: D1 (`migrations/`), accessed via `src/lib/store/*` and `src/lib/story.ts`.
- Local dev: `pnpm dev` (wrangler), `pnpm test` (vitest), `pnpm typecheck` (tsc).
- Deploy: `pnpm deploy`. Secrets via `.dev.vars` (local) / `wrangler secret put` (prod) — never commit real secrets.

See `README.md` for setup, config, and deploy details.
