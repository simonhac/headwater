@AGENTS.md

## Build & deploy (this is a Cloudflare Worker, not Next.js)

- **Deploy:** `npm run deploy` (= `wrangler deploy`). Do **NOT** run `pnpm deploy` — that
  triggers pnpm's built-in "deploy a workspace package" command and fails with
  `ERR_PNPM_NOTHING_TO_DEPLOY`. Use `npm run deploy`, `pnpm run deploy`, or `npx wrangler deploy`.
- **Pre-commit check:** `npm run typecheck && npm test` (the global `npm run build:local` rule is
  for Next.js repos and does not apply here — there's no such script). To also catch bundling /
  circular-import errors without uploading: `npx wrangler deploy --dry-run --outdir /tmp/hw-build`.
- After deploying, optionally bump the `build` marker in `src/index.ts` (`/health` → `build`) so the
  running version is visible; `wrangler deploy` also prints the Version ID.

## Operational log

- **2026-09-08 — Slack app finally renamed MeltStreem → Headwater.** Renaming the app (Basic
  Information → Display Information) and the bot display name (App Home → App Display Name), then
  reinstalling, did **not** change the name Slack shows on cards — it had been stuck since the July
  rebrand. Slack keeps three separate name records: the app name, the **bot record** (`bots.info` →
  `bot.name`, which the rename *does* update, and which `bot_profile.name` on a new message reflects),
  and the **bot user profile** (`users.info` → `real_name` / `display_name`), written once when the
  bot user is created at first install. The clients — desktop *and* web — render the third one, so
  `bot_profile.name: "Headwater"` still displayed as "MeltStreem". A reinstall re-grants scopes and
  re-issues tokens; it never rewrites the bot user. Fix: `users.profile.set` on the bot user
  (`U0BFQKZJXT8`) with `display_name` + `real_name` = `Headwater`. It needs an **`xoxp-` user token**
  from a Workspace Owner/Admin with `users.profile:write` (a bot token gets `not_allowed_token_type`);
  grant it as a *User* Token Scope, reinstall, run the one call, then remove the scope and reinstall
  to revoke — that token can edit any member profile at or below your role, so never store it.
  Historical cards relabel retroactively (they render from the live profile). The deprecated `name`
  handle stays `meltstreem` and has no API to change it, but `@`-autocomplete matches `display_name`,
  so `@Headwater` resolves. `chat:write.customize` is *not* the answer — it only overrides the name in
  the message header, never the handle, and Slack's own changelog advises apps not to set `username`.

- **2026-07-10 — Meltwater webhook re-pointed to the custom domain.** The feed had been
  silent ~26h. Root cause: during config hardening the Worker was moved from its
  `<worker>.workers.dev` URL to the the custom domain custom domain **and the
  workers.dev subdomain was disabled**, which orphaned Meltwater's Generic Webhook (it was
  still aimed at the now-dead workers.dev URL, so deliveries 404'd at Cloudflare's edge and
  never reached the Worker — invisible in `/inspect`). Meltwater's webhook UI can't edit a
  saved URL (it masks it to `<your-host>/***`; delete + re-add only). Fix: created a new
  Generic Webhook connection **`headwater 20260710b`** →
  `https://<your-host>/webhooks/meltwater/<WEBHOOK_SHARED_SECRET>` (token prefix
  `511a960123a…` verified against the deployed secret). **Fixed:** the three Every-Mention alerts weren't
  bound to the webhook — ticking `headwater 20260710b` under Alerts → Delivery method
  restored the feed (verified 2026-07-10: 8 mentions parsed → filtered → posted to Slack).
  See README §c ("What the Generic Webhook UI does *not* give you").
