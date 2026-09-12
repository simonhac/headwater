# 1Password-backed template for local `wrangler dev`. Regenerate the gitignored `.dev.vars` with:
#
#   op inject -i .dev.vars.tpl -o .dev.vars --force
#
# Conductor does it for you: env/workspace.config.yaml runs the `opInjectEnv` phase under the
# read-only service account op-sa-headwater-dev, which can read exactly ONE vault: `headwater-dev`.
#
# Source of truth for LOCAL dev: 1Password vault `headwater-dev`, item `env`. The deployed Worker's
# real secrets live in the headwater-prod vault and are delivered with `wrangler secret put`. This
# file must never reference that vault — a laptop is its own secret environment, so a dev value is a
# throwaway or a deliberate blank, never a copy of production's. (Pointing this template at the prod
# vault is exactly what broke Conductor setup between 2026-08-07 and 2026-09-12.)
#
# TWO TRAPS, both load-bearing:
#   1. `op inject` resolves references ANYWHERE in this file, comments included — never write the
#      reference scheme in prose unless that field really exists in `headwater-dev`.
#   2. Naming a field the vault does not have fails the WHOLE inject, not just that line. Only the
#      two fields below may appear as references.
#
# The blanks are deliberate, and each one is a guard:
#   SLACK_BOT_TOKEN       blank -> every Slack call short-circuits `no_slack_token`, so a worktree
#                         is structurally incapable of posting to the live channel. The pipeline
#                         still parses, filters and renders the Block Kit preview in /inspect.
#   SLACK_SIGNING_SECRET  blank -> POST /slack/commands answers 503. Correct: no Slack app points
#                         at localhost.
#   RESEND_API_KEY        blank -> the mailer is unconfigured, so no digest can be sent. LOAD-
#                         BEARING: wrangler.jsonc commits DIGEST_ENABLED "true" and `wrangler dev`
#                         reads vars too, so DIGEST_ENABLED=false below is the second guard.
#   ACCESS_TEAM_DOMAIN /  unused locally, because DEV_SKIP_ACCESS=true and `wrangler dev` has no
#   ACCESS_AUD            Cloudflare Access in front of it.
#
# Consequence: `GET /health` reads configOk:false locally, naming SLACK_BOT_TOKEN and
# SLACK_DEFAULT_CHANNEL as missing. That is correct on a laptop, not a fault to fix.
#
# Not here at all: the dead-man's-switch / heartbeat URLs a deployment might carry. Unset means off,
# and off is the only safe setting outside production.

# The auth token embedded in the webhook URL (POST /webhooks/meltwater/<this>). Local throwaway:
# it authenticates nothing external and gates only this laptop's own webhook path.
WEBHOOK_SHARED_SECRET=op://headwater-dev/env/WEBHOOK_SHARED_SECRET

# Bearer token for the /admin/* endpoints (Authorization: Bearer <this>). Local throwaway, as above.
# Aiming the package.json admin scripts at production needs the PROD value instead, fetched per
# invocation under your own 1Password session — never from the Keychain service account.
REPLAY_KEY=op://headwater-dev/env/REPLAY_KEY

# Slack — blank locally (see above). To exercise posting, paste a real xoxb- token and channel id
# into .dev.vars by hand; it is gitignored, and this template will overwrite them on the next inject.
SLACK_BOT_TOKEN=
SLACK_DEFAULT_CHANNEL=
SLACK_SIGNING_SECRET=

# Daily digest email (Resend) — blank, plus the master switch off, so a laptop can never mail
# subscribers. Recipients are not env: they subscribe from Slack with `/digest subscribe [time]`.
DIGEST_ENABLED=false
RESEND_API_KEY=
DIGEST_FROM=

# Cloudflare Access identifiers — blank locally; see DEV_SKIP_ACCESS below.
ACCESS_TEAM_DOMAIN=
ACCESS_AUD=

# Local dev ONLY — opens /inspect + /api locally (wrangler dev has no Access in front). Never in prod.
DEV_SKIP_ACCESS=true
