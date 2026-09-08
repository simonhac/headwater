# 1Password-backed template for local wrangler-dev + /admin/* secrets.
# Regenerate the gitignored `.dev.vars` from the vault (uses the my.1password.com desktop session):
#
#   op inject --account my.1password.com -i .dev.vars.tpl -o .dev.vars
#
# Source of truth: 1Password vault `headwater-prod`, item `env` — one field per var (label = var name).
# This template holds ONLY 1Password references (no secret values), so it is safe to commit. `.dev.vars`
# is gitignored. Disposition map: infra-setup `config/headwater.json`.
# NOTE: op inject resolves references ANYWHERE in this file (comments included) — never write the
# reference scheme in prose here unless that field exists in the vault.

# The auth token embedded in the webhook URL (POST /webhooks/meltwater/<this>).
WEBHOOK_SHARED_SECRET=op://headwater-prod/env/WEBHOOK_SHARED_SECRET

# Bearer token for the /admin/* endpoints (Authorization: Bearer <this>).
REPLAY_KEY=op://headwater-prod/env/REPLAY_KEY

# Slack bot token (xoxb-…) with chat:write.
SLACK_BOT_TOKEN=op://headwater-prod/env/SLACK_BOT_TOKEN
# Slack channel id (e.g. C0123ABCD).
SLACK_DEFAULT_CHANNEL=op://headwater-prod/env/SLACK_DEFAULT_CHANNEL
# Slack app Signing Secret (Basic Information) — verifies the /digest slash command on /slack/commands.
SLACK_SIGNING_SECRET=op://headwater-prod/env/SLACK_SIGNING_SECRET

# Cloudflare Access identifiers (verify the Access JWT on /inspect + /api). Not secrets, but vault-held.
ACCESS_TEAM_DOMAIN=op://headwater-prod/env/ACCESS_TEAM_DOMAIN
ACCESS_AUD=op://headwater-prod/env/ACCESS_AUD

# Local dev ONLY — opens /inspect + /api locally (wrangler dev has no Access in front). Never in prod.
DEV_SKIP_ACCESS=true
