export interface Env {
  /** D1 database — webhook_events + seen_mentions (see migrations/). */
  DB: D1Database;

  // --- non-secret vars (wrangler.jsonc) ---
  /** "true" to actually post to Slack. Stays "false" until the payload is confirmed + a bot token is wired. */
  POSTING_ENABLED: string;

  // --- secrets (.dev.vars locally; `wrangler secret put` in prod) ---
  /** Path token guarding POST /webhooks/meltwater/:token */
  WEBHOOK_SHARED_SECRET?: string;
  /** Query-key guarding /inspect and /api/webhooks/* */
  INSPECT_KEY?: string;
  /** Slack bot token (xoxb-…) with chat:write */
  SLACK_BOT_TOKEN?: string;
  /** Default Slack channel id/name for the trial feed */
  SLACK_DEFAULT_CHANNEL?: string;
}
