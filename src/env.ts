import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { StationRenderer } from "@/do/stationRenderer";

export interface Env {
  /** D1 database — webhook_events + seen_mentions (see migrations/). */
  DB: D1Database;

  /** Cloudflare Browser Rendering binding — resolves broadcast station names from the JS viewer.
   * Optional so tests/pool envs without the binding type-check; renderViewerTitle no-ops when absent. */
  BROWSER?: BrowserWorker;

  /** Serial broadcast-station render drainer (Durable Object). The only place a browser is launched;
   * one account-wide instance serializes renders under the free-tier limits. Optional so unit tests
   * without the binding type-check (enqueue/poke no-op when absent). */
  STATION_RENDERER?: DurableObjectNamespace<StationRenderer>;

  /** Sequential ingestion queue (wrangler.jsonc queues.producers). The webhook handler enqueues the
   * archived event id; the queue() consumer drains it one-at-a-time (max_concurrency=1) so every
   * near-dup lookup sees all prior stories. Optional so hand-built test envs type-check; a missing
   * binding degrades the handler to the in-request waitUntil path (local dev / tests). */
  INGEST_QUEUE?: Queue<string>;

  // --- non-secret vars (wrangler.jsonc) ---
  /** "true" to actually post to Slack. Stays "false" until the payload is confirmed + a bot token is wired. */
  POSTING_ENABLED: string;
  /** Cloudflare Access team domain (e.g. https://team.cloudflareaccess.com) — verifies /inspect+/api JWTs. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag for the /inspect+/api app. */
  ACCESS_AUD?: string;
  /** Local-dev ONLY (set in .dev.vars): "true" bypasses the Access check on /inspect+/api because
   * `wrangler dev` has no Cloudflare Access in front of it. NEVER set in wrangler.jsonc or prod. */
  DEV_SKIP_ACCESS?: string;

  // --- secrets (.dev.vars locally; `wrangler secret put` in prod) ---
  /** Path token guarding POST /webhooks/meltwater/:token */
  WEBHOOK_SHARED_SECRET?: string;
  /** Slack bot token (xoxb-…) with chat:write */
  SLACK_BOT_TOKEN?: string;
  /** Default Slack channel id/name for the trial feed */
  SLACK_DEFAULT_CHANNEL?: string;
  /** Slack app Signing Secret (Basic Information) — verifies inbound slash commands on /slack/commands.
   * Unset = the route answers 503 and the `/digest` command is unavailable. */
  SLACK_SIGNING_SECRET?: string;
  /** Bearer token (Authorization: Bearer …) guarding the /admin/* endpoints. */
  REPLAY_KEY?: string;

  // --- ingestion heartbeat (all optional; sensible defaults in src/lib/heartbeat.ts) ---
  /** Escape hatch for the stall threshold: when set it overrides BOTH days with this one flat
   *  value. Unset (the normal case) means the measured time-of-week default — 16h on a weekday,
   *  24h at the weekend (src/lib/heartbeat.ts). */
  HEARTBEAT_MAX_SILENCE_HOURS?: string;
  /** While a stall persists, re-alert at most once per this many hours (default 6). */
  HEARTBEAT_REALERT_HOURS?: string;
  /** Channel for heartbeat alerts; falls back to SLACK_DEFAULT_CHANNEL. */
  SLACK_ALERT_CHANNEL?: string;

  // --- daily digest email (src/lib/digestSend.ts), delivered via Resend (src/lib/mailer.ts).
  // Cloudflare Email Sending would have needed Workers Paid on the account owning the sending
  // domain — a second subscription — while the sending domain is already verified in Resend. ---
  /** Master switch, strict `=== "true"` like POSTING_ENABLED. Anything else = no mail is ever sent. */
  DIGEST_ENABLED?: string;
  /** Resend API key, `re_…` (secret). */
  RESEND_API_KEY?: string;
  /** From address on a Resend-verified domain — e.g. digest@example.org */
  DIGEST_FROM?: string;
  /** Display name for the From header (default "Headwater"). */
  DIGEST_FROM_NAME?: string;
  /** Reply-To — set this if the From address isn't a real mailbox, so replies don't bounce. */
  DIGEST_REPLY_TO?: string;
  /** Optional Slack channel link for the digest footer. */
  DIGEST_SLACK_URL?: string;
}
