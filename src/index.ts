import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@/env";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { processEvent } from "@/lib/process";
import { replayArchivedEvents } from "@/lib/replay";
import { redecodeRecentStories } from "@/lib/redecode";
import { coalesceDuplicateStories } from "@/lib/coalesce";
import { renderViewerTitle } from "@/lib/meltwater/station-resolve";
import { pokeStationRender, getRenderState } from "@/do/client";
import { backfillStations } from "@/lib/backfill";
import { listStationResolutions } from "@/lib/meltwater/stations";
import { renderStationsPage } from "@/ui/stations";
import { accessOk, checkBearer } from "@/lib/auth";
import { withRetry } from "@/lib/retry";
import { eventId, timingSafeEqualStr } from "@/lib/ids";
import { renderInspectPage } from "@/ui/inspect";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import { runHeartbeat } from "@/lib/heartbeat";

const app = new Hono<{ Bindings: Env }>();

// Never leak a page's URL to sites it links out to. Belt-and-suspenders on top of browsers' default
// query-stripping (moot now that auth is a header/cookie rather than a ?key=).
app.use("*", async (c, next) => {
  await next();
  c.header("Referrer-Policy", "no-referrer");
});

/** How far back /health's drift gauge looks (keeps the count bounded + actionable). */
const DRIFT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Reconcile look-back: the 72h syndication window, so a straggler can still merge into its story. */
const RECONCILE_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Don't reconcile events newer than this — let the live `waitUntil` path settle first so the cron
 * never races in-flight processing (a fresh straggler just heals on a later tick). */
const RECONCILE_SETTLE_MS = 15 * 60 * 1000;
/** Hourly healer look-back (NOT a cadence): re-render stories touched in this window so a station
 * named since the card posted (by the drainer / authorName-trust) upgrades in place. Hash-gated, so a
 * card that didn't change is never re-sent to Slack. Matches the reconcile/syndication window. */
const HEAL_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Ingestion archive-write backoff (ms): 3 attempts total before returning 5xx. */
const ARCHIVE_RETRY_BACKOFFS_MS = [50, 150];

/**
 * Self-healing sweep (Cron Trigger). Re-runs a bounded, recent window of archived events back
 * through the pipeline. Because dedupe/merge are `seen`-aware, already-handled mentions are skipped
 * as duplicates (no Slack call) and only un-posted stragglers actually re-post/merge —
 * `EventLog.markProcessed` is monotonic so healthy rows are never downgraded.
 *
 * Note: after `POSTING_ENABLED` flips false→true, everything archived while paused is un-`seen`, so
 * the next tick catches up the last-72h backlog (bounded by the window + Slack's rate-limit backoff).
 */
async function reconcile(env: Env): Promise<void> {
  if (env.POSTING_ENABLED !== "true") return; // mirror the /admin/replay gate
  const now = Date.now();
  const res = await replayArchivedEvents(env, { sinceMs: now - RECONCILE_LOOKBACK_MS, untilMs: now - RECONCILE_SETTLE_MS });
  // Surface drift to Workers observability (already enabled). A non-zero `failed`/`errors` that
  // doesn't drain across ticks means a genuinely stuck event worth a look.
  if (res.posted || res.merged || res.failed || res.errors) {
    console.warn(
      `[reconcile] events=${res.events} healed_posted=${res.posted} healed_merged=${res.merged} still_failed=${res.failed} errors=${res.errors}`,
    );
  }
}

/**
 * Hourly card healer. Re-renders stories touched in the last HEAL_LOOKBACK_MS under the current
 * decoding and chat.updates only the ones whose rendering changed — i.e. broadcast cards whose station
 * was named (by the serial renderer or authorName-trust) after the card first posted. Hash-gated
 * (`render_hash`), so unchanged cards are never re-sent. Gated on posting, like /admin/redecode.
 */
async function heal(env: Env): Promise<void> {
  if (env.POSTING_ENABLED !== "true") return;
  const res = await redecodeRecentStories(env, { hours: HEAL_LOOKBACK_MS / 3_600_000, dryRun: false, now: Date.now() });
  if (res.updated || res.failed || res.remaining) {
    console.warn(
      `[heal] scanned=${res.scanned} changed=${res.changed} updated=${res.updated} failed=${res.failed} remaining=${res.remaining}`,
    );
  }
}

// --- health / status (no secrets leaked). Root "/" falls through to 404. ---
app.get("/health", async (c) => {
  let count = 0;
  // Drift gauge over the last DRIFT_WINDOW_MS: `errors` = failed/threw events, `unposted` =
  // archived-but-never-delivered. Non-zero counts that don't drain across reconcile ticks = drift.
  let drift: { errors: number; unposted: number } | null = null;
  try {
    const log = new EventLog(c.env.DB);
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_events`).first<{ n: number }>();
    count = row?.n ?? 0;
    drift = await log.driftCounts(Date.now() - DRIFT_WINDOW_MS);
  } catch {
    /* DB not migrated yet */
  }
  // Format-validate the runtime env (never leaks values). Only the `configOk` boolean is public.
  const config = summarizeConfig(validateConfig(c.env));
  return c.json({
    service: "headwater",
    build: "headwater-11", // bump on each deploy to confirm the running code
    postingEnabled: c.env.POSTING_ENABLED === "true",
    events: count,
    drift, // { errors, unposted } over the last 7 days; null until the DB is migrated
    configOk: config.ok,
    configured: {
      webhookSecret: !!c.env.WEBHOOK_SHARED_SECRET,
      slackToken: !!c.env.SLACK_BOT_TOKEN,
      slackChannel: !!c.env.SLACK_DEFAULT_CHANNEL,
      accessConfigured: !!c.env.ACCESS_TEAM_DOMAIN && !!c.env.ACCESS_AUD,
    },
  });
});

// --- inbound Meltwater Generic Webhook ---
app.post("/webhooks/meltwater/:token", async (c) => {
  if (!c.env.WEBHOOK_SHARED_SECRET) return c.text("WEBHOOK_SHARED_SECRET not configured", 503);
  if (!timingSafeEqualStr(c.req.param("token"), c.env.WEBHOOK_SHARED_SECRET)) {
    return c.text("forbidden", 403);
  }

  const raw = await c.req.text();
  const receivedAt = Date.now();
  const id = eventId(receivedAt);
  const eventLog = new EventLog(c.env.DB);

  // Persist the raw payload FIRST so we never lose it, even if processing throws.
  let payload: unknown = null;
  let parseError: string | null = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    parseError = "non_json_body";
  }
  // The archive is the source of truth. If we can't even persist the payload after a few tries,
  // fail loud (5xx) so the sender retries rather than silently ack'ing a lost mention. `append` is
  // INSERT OR IGNORE, so a retry after a partial commit is a safe no-op.
  try {
    await withRetry(
      () => eventLog.append({ id, receivedAt, raw, decision: parseError ? "error" : "logged", reason: parseError }),
      ARCHIVE_RETRY_BACKOFFS_MS,
    );
  } catch (e) {
    console.error(`[ingest] archive write failed for ${id}: ${String(e)}`);
    return c.text("archive_failed", 500);
  }

  // Ack immediately; do parse/filter/post after the response (Workers' after-response primitive).
  if (!parseError) {
    const seen = new SeenStore(c.env.DB);
    c.executionCtx.waitUntil(
      processEvent(c.env, eventLog, seen, id, payload, receivedAt).catch(async (e) => {
        await eventLog.markProcessed(id, { decision: "error", error: String(e) }).catch(() => {});
      }),
    );
  }

  return c.text("ok", 200);
});

// --- inspection (gated by Cloudflare Access — verify the injected JWT, fail-closed) ---
app.get("/api/webhooks/recent", async (c) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
  const events = await new EventLog(c.env.DB).recent(limit);
  return c.json(events);
});

// --- admin: reparse + repost the archived real webhooks (gated by REPLAY_KEY) ---
app.post("/admin/replay", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  if (c.env.POSTING_ENABLED !== "true") return c.text("POSTING_ENABLED is not true", 409);
  try {
    const result = await replayArchivedEvents(c.env, {
      reset: c.req.query("reset") === "1",
      purge: c.req.query("purge") === "1",
      purgeOnly: c.req.query("purgeOnly") === "1",
      limit: Number(c.req.query("limit")) || undefined, // replay only the N most recent posted events
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: re-render recent stories' cards under the current decoding and chat.update them in place
// (non-destructive; preserves reactions/threads). Gated by REPLAY_KEY. `hours` window defaults to 7
// days; `dryRun=1` previews the changes without touching Slack. ---
app.post("/admin/redecode", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const dryRun = c.req.query("dryRun") === "1";
  if (!dryRun && c.env.POSTING_ENABLED !== "true") {
    return c.text("POSTING_ENABLED is not true (use dryRun=1 to preview)", 409);
  }
  const hoursRaw = Number(c.req.query("hours"));
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24 * 7;
  try {
    const result = await redecodeRecentStories(c.env, { hours, dryRun, now: Date.now() });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: coalesce broadcast duplicates posted (before near-dup detection deployed) as separate
// messages. Re-clusters the last `hours` of broadcast stories with the SAME near-dup engine, edits
// the oldest message in each group to list all outlets, and deletes the redundant ones IN PLACE
// (reactions/threads on the survivor preserved — this is NOT the destructive replay/purge path).
// Re-resolves each clustered member's station from the current D1 map, so merged cards show real
// station names (not the presenter byline / neutral masthead frozen at ingestion). Gated by
// REPLAY_KEY; `hours` defaults to 7 days (`all=1` scans day 0 → now); `dryRun=1` previews without
// touching Slack/D1. Re-run until `remaining=0` (idempotent). ---
app.post("/admin/coalesce", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const dryRun = c.req.query("dryRun") === "1";
  if (!dryRun && c.env.POSTING_ENABLED !== "true") {
    return c.text("POSTING_ENABLED is not true (use dryRun=1 to preview)", 409);
  }
  // `all=1` scans every broadcast story ever (day 0); otherwise `hours` bounds the window (default 7d).
  const hoursRaw = Number(c.req.query("hours"));
  const hours = c.req.query("all") === "1" ? 0 : Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24 * 7;
  try {
    const result = await coalesceDuplicateStories(c.env, { hours, dryRun, now: Date.now() });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: verify Browser Rendering — render a Meltwater viewer URL and return its title/station.
// Gated by REPLAY_KEY; host-restricted to meltwater.com so it can't render arbitrary URLs. ---
app.get("/admin/render-station", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const url = c.req.query("url") ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return c.json({ error: "invalid url" }, 400);
  }
  if (!/(^|\.)meltwater\.com$/.test(host)) return c.json({ error: "url host must be meltwater.com" }, 400);
  const title = await renderViewerTitle(c.env, url);
  return c.json({ title, station: title ? (title.split(" - ")[0]?.trim() ?? null) : null });
});

// --- admin: one-time warm start — re-scan the archive, seed station_names from station-like
// authorNames and enqueue still-unnamed broadcast codes for the serial renderer. Gated by REPLAY_KEY.
// `limit` caps events scanned (newest first); re-runnable (dedupe is by code). ---
app.post("/admin/backfill-stations", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const limit = Math.min(Number(c.req.query("limit")) || 1000, 5000);
  try {
    return c.json(await backfillStations(c.env, { limit }));
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: run the ingestion heartbeat on demand (same check the cron runs); gated by REPLAY_KEY ---
app.get("/admin/heartbeat", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  return c.json(await runHeartbeat(c.env, Date.now()));
});

// --- broadcast station-code resolution status (gated by Cloudflare Access). Mounted at BOTH /stations
// and /inspect/stations: the latter falls under the existing `/inspect` Access destination, so it works
// without adding a new destination; /stations needs its own destination (Zero Trust → Access). ---
const stationsPage = async (c: Context<{ Bindings: Env }>) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  const [rows, state] = await Promise.all([listStationResolutions(c.env.DB), getRenderState(c.env)]);
  // Viewing the status also nudges the drainer — a refresh can pull a budget-deferred alarm earlier.
  c.executionCtx.waitUntil(pokeStationRender(c.env).catch(() => {}));
  return c.html(renderStationsPage(rows, state));
};
app.get("/stations", stationsPage);
app.get("/inspect/stations", stationsPage);

app.get("/inspect", async (c) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  const PAGE_SIZE = 50;
  const beforeRaw = Number(c.req.query("before"));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const failedOnly = c.req.query("filter") === "failed";
  const log = new EventLog(c.env.DB);
  const sinceMs = Date.now() - DRIFT_WINDOW_MS; // failed list + badge share one window so they agree
  const events = failedOnly ? await log.failures(sinceMs, before, PAGE_SIZE) : await log.page(before, PAGE_SIZE);
  // A full page implies older history may exist; the cursor is the oldest row shown.
  const olderCursor = events.length === PAGE_SIZE ? events[events.length - 1]!.received_at : null;
  const failedCount = await log.failuresCount(sinceMs).catch(() => 0);
  // No ?key= needed — Access's session cookie authenticates the pager/JSON links.
  return c.html(renderInspectPage(events, "", { before, olderCursor, failedOnly, failedCount }));
});

// Cron Triggers (wrangler.jsonc `triggers.crons`), dispatched by controller.cron:
//   "*/15 * * * *" → self-healing reconcile;  "0 * * * *" → hourly ingestion heartbeat.
// (At the top of the hour both fire — Cloudflare invokes scheduled() once per matching cron.)
// Never throw out of scheduled() — a rejected cron just retries noisily; each job self-reports.
export { StationRenderer } from "@/do/stationRenderer";

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(runHeartbeat(env, Date.now()).catch(() => {}));
      ctx.waitUntil(heal(env).catch((e) => console.error(`[heal] failed: ${String(e)}`)));
    } else {
      // Reconcile, THEN backstop the drainer (in case an enqueue's poke was lost). One waitUntil so
      // both run to completion within the request — poke on an empty queue is a no-op (no stray alarm).
      ctx.waitUntil(
        reconcile(env)
          .catch((e) => console.error(`[reconcile] failed: ${String(e)}`))
          .then(() => pokeStationRender(env))
          .catch(() => {}),
      );
    }
  },
} satisfies ExportedHandler<Env>;
