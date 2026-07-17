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
  /** Bearer token (Authorization: Bearer …) guarding the /admin/* endpoints. */
  REPLAY_KEY?: string;

  // --- ingestion heartbeat (all optional; sensible defaults in src/lib/heartbeat.ts) ---
  /** Alert if no webhook has arrived in this many hours (default 24). */
  HEARTBEAT_MAX_SILENCE_HOURS?: string;
  /** While a stall persists, re-alert at most once per this many hours (default 6). */
  HEARTBEAT_REALERT_HOURS?: string;
  /** Channel for heartbeat alerts; falls back to SLACK_DEFAULT_CHANNEL. */
  SLACK_ALERT_CHANNEL?: string;
}
