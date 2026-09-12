import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@/env";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { processEvent } from "@/lib/process";
import { replayArchivedEvents } from "@/lib/replay";
import { redecodeRecentStories } from "@/lib/redecode";
import { coalesceDuplicateStories } from "@/lib/coalesce";
import { sweepOrphans } from "@/lib/orphans";
import { repairSnippets } from "@/lib/snippets";
import { cleanupTestPosts, sendTestPosts } from "@/lib/testpost";
import { renderViewerTitle } from "@/lib/meltwater/station-resolve";
import { pokeStationRender, getRenderState } from "@/do/client";
import { backfillStations } from "@/lib/backfill";
import { listStationResolutions } from "@/lib/meltwater/stations";
import { renderStationsPage } from "@/ui/stations";
import { accessOk, checkBearer } from "@/lib/auth";
import { configuredChannels, emptyRouting, loadRouting, parseRoutingForm, saveRouting } from "@/lib/routing";
import { listBotChannels } from "@/lib/slack/channels";
import { renderRoutingPage } from "@/ui/routing";
import { feedConfig } from "@/config/feed.config";
import { withRetry } from "@/lib/retry";
import { eventId, timingSafeEqualStr } from "@/lib/ids";
import { renderInspectPage } from "@/ui/inspect";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import { maxSilenceHours, runHeartbeat } from "@/lib/heartbeat";
import { OpsState } from "@/lib/store/opsState";
import { MEDIA_ICON_PNG } from "@/assets/mediaIcons";
import { buildDigest, DIGEST_TZ } from "@/lib/digest";
import { assessHealth, HOURLY_TICK_KEY, PROCESSING_STALE_MINUTES, PROCESSING_WINDOW_HOURS, QUARTER_HOURLY_TICK_KEY } from "@/lib/health";
import { renderDigestEmail, renderDigestText } from "@/ui/email";
import { runDigestSend } from "@/lib/digestSend";
import { SubscriberStore } from "@/lib/store/subscribers";
import { verifySlackSignature } from "@/lib/slack/verify";
import { handleDigestCommand } from "@/lib/slack/commands";

const app = new Hono<{ Bindings: Env }>();

// Never leak a page's URL to sites it links out to. Belt-and-suspenders on top of browsers' default
// query-stripping (moot now that auth is a header/cookie rather than a ?key=).
app.use("*", async (c, next) => {
  await next();
  c.header("Referrer-Policy", "no-referrer");
});

/**
 * Record that a cron branch ran, for /health to assert freshness on. Best-effort: a failed marker
 * write must never throw out of scheduled() (a rejected cron just retries noisily), and one missed
 * write is covered by the threshold, which tolerates more than one interval.
 */
async function markCronTick(env: Env, key: string): Promise<void> {
  const now = Date.now();
  try {
    await new OpsState(env.DB).set(key, String(now), now);
  } catch (e) {
    console.error(`[cron] marker ${key} failed: ${String(e)}`);
  }
}

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
  const now = Date.now();
  let count = 0;
  let subscribers = 0;
  // Drift gauge over the last DRIFT_WINDOW_MS: `errors` = failed/threw events, `unposted` =
  // archived-but-never-delivered. Non-zero counts that don't drain across reconcile ticks = drift.
  let drift: { errors: number; unposted: number } | null = null;
  // A dead database used to be INVISIBLE here: the catch swallowed it and the route still returned
  // 200 with drift:null, so an uptime monitor stayed green through it. It now fails the check.
  // This is what lets ONE keyword monitor cover both config breakage and a dead DB — BetterStack's
  // `keyword` type requires a 2xx *and* the keyword.
  let dbOk = true;
  // Everything else this endpoint asserts on. /health is the SINGLE assertion point for headwater:
  // the uptime monitor polls it every 180s, so failing closed here detects a fault ~20x faster than
  // a 1h heartbeat could, which is why the dead-man's-switch pings were retired in its favour.
  let health: ReturnType<typeof assessHealth> | null = null;
  let gauges: { lastReceivedAt: number | null; lastProcessedAt: number | null } | null = null;
  try {
    const log = new EventLog(c.env.DB);
    // One pass for the count + every freshness gauge. The windows are DERIVED from the constants
    // that define them — a failure only counts as stuck once it is older than the window reconcile
    // heals within, because recent drift is expected and asserting on it would false-alarm.
    const g = await log.healthGauges({
      unprocessedSinceMs: now - PROCESSING_WINDOW_HOURS * 60 * 60 * 1000,
      unprocessedUntilMs: now - PROCESSING_STALE_MINUTES * 60 * 1000,
      stuckSinceMs: now - DRIFT_WINDOW_MS,
      stuckUntilMs: now - RECONCILE_LOOKBACK_MS,
    });
    count = g.events;
    gauges = { lastReceivedAt: g.lastReceivedAt, lastProcessedAt: g.lastProcessedAt };
    drift = await log.driftCounts(now - DRIFT_WINDOW_MS);
    subscribers = await new SubscriberStore(c.env.DB).count();
    const ticks = await new OpsState(c.env.DB).getNumbers([HOURLY_TICK_KEY, QUARTER_HOURLY_TICK_KEY]);
    health = assessHealth({
      now,
      // The same threshold the in-Worker Slack alert uses, so the two cannot disagree about what
      // "stalled" means — and time-of-week aware, because the feed's weekend tail is real (20.3h
      // observed) while its weekday tail is not (8.8h).
      feedThresholdHours: maxSilenceHours(c.env, now),
      gauges: {
        ...g,
        hourlyTickAt: ticks.get(HOURLY_TICK_KEY) ?? null,
        quarterHourlyTickAt: ticks.get(QUARTER_HOURLY_TICK_KEY) ?? null,
      },
    });
  } catch (e) {
    dbOk = false;
    console.error(`[health] database unreadable: ${String(e)}`);
  }
  // Format-validate the runtime env + saved routing (never leaks values, and channel ids are
  // treated as secret). Only the `configOk` boolean is public.
  const routing = await loadRouting(c.env.DB).catch(() => emptyRouting());
  const config = summarizeConfig(validateConfig(c.env, routing));
  return c.json({
    service: "headwater",
    build: "headwater-38", // bump on each deploy to confirm the running code
    postingEnabled: c.env.POSTING_ENABLED === "true",
    digestEnabled: c.env.DIGEST_ENABLED === "true",
    digestSubscribers: subscribers, // count only — addresses stay in D1
    events: count,
    drift, // { errors, unposted } over the last 7 days; null until the DB is migrated
    // Every fault, individually. One monitor means one alarm, so the diagnosis has to live in the
    // body — read `checks` before anything else when this goes red.
    checks: health?.checks ?? null,
    lastReceivedAt: gauges?.lastReceivedAt ?? null, // arrival …
    lastProcessedAt: gauges?.lastProcessedAt ?? null, // … vs processed: recent + stale = broken pipeline
    configOk: config.ok,
    configured: {
      webhookSecret: !!c.env.WEBHOOK_SHARED_SECRET,
      slackToken: !!c.env.SLACK_BOT_TOKEN,
      slackChannel: !!c.env.SLACK_DEFAULT_CHANNEL,
      accessConfigured: !!c.env.ACCESS_TEAM_DOMAIN && !!c.env.ACCESS_AUD,
      // Booleans only — never the key or the From address.
      digestMailer: !!c.env.RESEND_API_KEY && !!c.env.DIGEST_FROM,
      slackSigningSecret: !!c.env.SLACK_SIGNING_SECRET,
    },
    // How many distinct channels the feed fans out to (count only — ids are secret). 1 = default only.
    channels: configuredChannels(routing, c.env).length,
    dbOk,
    // FAIL CLOSED. The keyword monitor requires a 2xx AND `"configOk":true`, so a 503 here is
    // caught in ~6 minutes — and the body still carries the keyword, which is what keeps a failure
    // legible rather than merely absent. Do not "simplify" this back to a 200 on faults.
  }, dbOk && (health?.ok ?? true) ? 200 : 503);
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

  // Ack immediately; the queue consumer does parse/filter/post SEQUENTIALLY (max_concurrency=1), so
  // every near-dup lookup sees all prior stories (kills the simulcast-burst duplicate race). Message =
  // just the id; webhook_events is the source of truth (the consumer re-reads raw_json by id).
  if (!parseError) {
    if (c.env.INGEST_QUEUE) {
      try {
        await c.env.INGEST_QUEUE.send(id);
      } catch (e) {
        // Archived-but-not-enqueued: the payload is safe, so don't 5xx (that would trigger a
        // redundant sender re-POST). The 15-min reconcile re-drives this row (seen-aware, no double-post).
        console.error(`[ingest] enqueue failed for ${id} (reconcile will catch it): ${String(e)}`);
      }
    } else {
      // No queue binding (local dev / tests): process after the response, as before.
      const seen = new SeenStore(c.env.DB);
      c.executionCtx.waitUntil(
        processEvent(c.env, eventLog, seen, id, payload, receivedAt).catch(async (e) => {
          await eventLog.markProcessed(id, { decision: "error", error: String(e) }).catch(() => {});
        }),
      );
    }
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

// --- admin: repair snippets Meltwater truncated mid-sentence at either edge, in stories
// ALREADY stored, rewriting both the primary snapshot and each outlet's copy, and chat.updating any
// card whose rendering changes. Unlike /admin/redecode this touches outlets_json (where a
// high-reach outlet's own snippet leads the card) and persists data-only fixes. Gated by
// REPLAY_KEY; `dryRun=1` previews; `hours=N` sets the window (default 720); capped at 40 updates
// per call (re-run until `remaining` is 0). ---
app.post("/admin/repair-snippets", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const dryRun = c.req.query("dryRun") === "1";
  if (!dryRun && c.env.POSTING_ENABLED !== "true") {
    return c.text("POSTING_ENABLED is not true (use dryRun=1 to preview)", 409);
  }
  const hours = Number(c.req.query("hours") ?? 720);
  try {
    return c.json(await repairSnippets(c.env, { hours: Number.isFinite(hours) ? hours : 720, dryRun, now: Date.now() }));
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: post one synthetic card per brief, to wherever /inspect/routing sends that brief.
// Verifies routing without waiting for a Meltwater delivery (and for briefs whose search is quiet,
// it's the ONLY way to check). Gated by REPLAY_KEY. Defaults to a DRY RUN — pass `post=1` to
// actually post. `brief=<id>` limits it to one brief. Test cards are not stored, so they never
// merge with a real story; delete them from Slack when you're done. ---
app.post("/admin/test-post", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  // Opt IN to posting: the harmless spelling is the one you get by accident.
  const dryRun = c.req.query("post") !== "1";
  if (!dryRun && c.env.POSTING_ENABLED !== "true") {
    return c.text("POSTING_ENABLED is not true", 409);
  }
  try {
    // `cleanup=1` removes test cards instead of posting them. Matched on the title marker, so it
    // can only ever delete test cards — `/admin/orphans` would take real ones with them.
    if (c.req.query("cleanup") === "1") {
      return c.json(await cleanupTestPosts(c.env, { dryRun, tag: c.req.query("tag") ?? undefined }));
    }
    return c.json(await sendTestPosts(c.env, { dryRun, briefId: c.req.query("brief") ?? undefined }));
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// --- admin: delete orphan cards — the bot's own attachment-bearing messages whose ts has no backing
// `stories` row (left when a story row was removed but its Slack message wasn't). Heartbeat/text posts
// are never touched. Gated by REPLAY_KEY; `dryRun=1` previews; capped at 40 deletes/call (re-run until
// `remaining` is 0). ---
app.post("/admin/orphans", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const dryRun = c.req.query("dryRun") === "1";
  if (!dryRun && c.env.POSTING_ENABLED !== "true") {
    return c.text("POSTING_ENABLED is not true (use dryRun=1 to preview)", 409);
  }
  try {
    return c.json(await sweepOrphans(c.env, { dryRun }));
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

// --- media-type footer icons (Lucide PNGs, base64 in @/assets/mediaIcons). PUBLIC: Slack's image
// proxy fetches these unauthenticated for the attachment `footer_icon`, so this route is NOT behind
// Access. Versioned path (v1) so a future icon change gets a fresh URL past Slack's aggressive
// image-proxy cache; immutable long-cache since bytes never change under a given version. ---
app.get("/icons/media/v1/:name", (c) => {
  const slug = c.req.param("name").replace(/\.png$/, "");
  const b64 = MEDIA_ICON_PNG[slug];
  if (!b64) return c.notFound();
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
});

// --- brief → channel routing (gated by Cloudflare Access). Under /inspect/* so it's covered by the
// existing Access destination — no new Zero Trust config needed (see the /stations note above). ---
/** Turn a `conversations.list` failure into something actionable on the page. */
function channelListError(error: string): string {
  if (error === "missing_scope")
    return "Slack is missing the channels:read + groups:read scopes — add them under OAuth & Permissions, then Reinstall to workspace.";
  if (error === "no_slack_token") return "SLACK_BOT_TOKEN is not configured.";
  return `Slack error listing channels: ${error}`;
}

app.get("/inspect/routing", async (c) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  const [routing, list] = await Promise.all([loadRouting(c.env.DB), listBotChannels(c.env)]);
  return c.html(
    renderRoutingPage({
      briefs: feedConfig.briefs,
      channels: list.channels,
      routing,
      defaultChannel: c.env.SLACK_DEFAULT_CHANNEL ?? "",
      flash: c.req.query("saved") ? "Routing saved." : undefined,
      error: list.error ? channelListError(list.error) : undefined,
      diagnostic: `slack: ${list.scanned} conversations over ${list.pages} page(s), ${list.channels.length} with the bot as a member${list.truncated ? " (TRUNCATED — more pages remain)" : ""}`,
    }),
  );
});

app.post("/inspect/routing", async (c) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  // CSRF: Access authenticates the session cookie, which a cross-site form POST would also carry.
  // `Sec-Fetch-Site` is set by every browser that can reach this page; absent = a non-browser client.
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") return c.text("forbidden", 403);

  const list = await listBotChannels(c.env);
  if (list.error) return c.text(`slack error: ${list.error}`, 502);
  const briefIds = [...feedConfig.briefs.map((b) => b.id), "default"];
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  await saveRouting(c.env.DB, parseRoutingForm(body, briefIds, list.channels.map((ch) => ch.id)), Date.now());
  return c.redirect("/inspect/routing?saved=1", 303);
});

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

/**
 * Preview the periodic digest exactly as it will be emailed. Access-gated like /inspect.
 *
 *   /digest              last 24h
 *   /digest?days=7       last 7 days
 *   /digest?text=1       the text/plain alternative, so both parts can be eyeballed
 *
 * Read-only: renders from the stories table and sends nothing. This is the surface to iterate the
 * design on before any mail is wired up.
 */
app.get("/digest", async (c) => {
  if (!(await accessOk(c.env, c.req.header("cf-access-jwt-assertion")))) return c.text("forbidden", 403);
  const daysRaw = Number(c.req.query("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 30) : 1;
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;
  const digest = await buildDigest(c.env, sinceMs, untilMs);
  if (c.req.query("text")) return c.text(renderDigestText(digest, { timeZone: DIGEST_TZ }));
  return c.html(renderDigestEmail(digest, { timeZone: DIGEST_TZ }));
});

/**
 * Admin: run the digest send on demand — the same code path the cron uses. Gated by REPLAY_KEY
 * like the other /admin routes.
 *
 *   ?dryRun=1   build and render, report who is due and the story count, send NOTHING
 *               (ignores DIGEST_ENABLED)
 *   ?force=1    bypass every subscriber's time-of-day gate for a real send
 *
 * `force` deliberately does NOT bypass the already-sent-today guard — testing must never be able to
 * double-send a real digest to a real inbox.
 */
app.post("/admin/digest-send", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const dryRun = c.req.query("dryRun") === "1";
  const force = c.req.query("force") === "1";
  return c.json(await runDigestSend(c.env, Date.now(), { dryRun, force }));
});

/** Admin: the digest subscriber list (addresses included — this is the one place they surface). */
app.get("/admin/digest-subscribers", async (c) => {
  const gate = checkBearer(c.req.header("authorization"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  return c.json({ subscribers: await new SubscriberStore(c.env.DB).all() });
});

/**
 * Slack slash command endpoint (`/digest …`; src/lib/slack/commands.ts). Slack POSTs a form body and
 * signs it with the app's Signing Secret; the signature is verified over the RAW body before anything
 * is parsed, and the reply is an ephemeral message only the invoking user sees. Slack times out after
 * 3s, so the handler does one users.info call and one D1 write — no deferred response_url work.
 */
app.post("/slack/commands", async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) return c.text("SLACK_SIGNING_SECRET not configured", 503);
  const rawBody = await c.req.text();
  const ok = await verifySlackSignature({
    signingSecret: c.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header("x-slack-request-timestamp"),
    signature: c.req.header("x-slack-signature"),
    rawBody,
    nowMs: Date.now(),
  });
  if (!ok) return c.text("bad signature", 401);

  const form = new URLSearchParams(rawBody);
  const userId = form.get("user_id") ?? "";
  if (!userId) return c.text("missing user_id", 400);
  const reply = await handleDigestCommand(c.env, { userId, text: form.get("text") ?? "", nowMs: Date.now() });
  // `text` is always sent: notifications and table-less clients fall back to it (see buildWhoReply).
  return c.json({ response_type: "ephemeral", text: reply.text, ...(reply.blocks ? { blocks: reply.blocks } : {}) });
});

// Cron Triggers (wrangler.jsonc `triggers.crons`), dispatched by controller.cron:
//   "*/15 * * * *"  → self-healing reconcile + the per-subscriber digest send (each subscriber picks a
//                     local time in 15-minute steps; src/lib/digestSend.ts gates on their own clock)
//   "0 * * * *"     → hourly ingestion heartbeat + card healer
// (At the top of the hour both fire — Cloudflare invokes scheduled() once per matching cron.)
// Never throw out of scheduled() — a rejected cron just retries noisily; each job self-reports.
export { StationRenderer } from "@/do/stationRenderer";

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "0 * * * *") {
      // One waitUntil, but the two jobs still run CONCURRENTLY. An earlier version awaited them in
      // sequence, which quietly removed the failure isolation the two separate waitUntil calls had:
      // runHeartbeat's alert path calls slackFetch, which has no timeout and honours an uncapped
      // Retry-After, so a PENDING heartbeat would have blocked the healer indefinitely — and a
      // pending healer would have blocked the tick marker even with ingestion healthy and D1
      // readable.
      ctx.waitUntil(
        (async () => {
          const [hbResult] = await Promise.allSettled([
            runHeartbeat(env, Date.now()),
            heal(env).catch((e) => {
              console.error(`[heal] failed: ${String(e)}`);
            }),
          ]);
          if (hbResult.status === "rejected") {
            console.error(`[heartbeat] failed: ${String(hbResult.reason)}`);
          }
          if (hbResult.status === "fulfilled") {
            // The marker means "this tick ran and D1 was readable" — runHeartbeat cannot resolve
            // without two successful reads, so a fulfilled result IS the liveness evidence, exactly
            // what the retired hourly ping proved. It deliberately does NOT gate on heal() (a
            // best-effort re-render; gating would let a failed Slack update silence liveness) nor on
            // the heartbeat's verdict — a stalled feed is a separate check with its own threshold.
            await markCronTick(env, HOURLY_TICK_KEY);
          }
        })(),
      );
    } else {
      // Reconcile, THEN backstop the drainer (in case an enqueue's poke was lost), THEN the digest
      // send — so anyone due this tick gets a window that includes what reconcile just healed. One
      // waitUntil so all run to completion within the request — poke on an empty queue is a no-op
      // (no stray alarm), and the digest returns immediately when nobody is due.
      ctx.waitUntil(
        reconcile(env)
          .catch((e) => console.error(`[reconcile] failed: ${String(e)}`))
          .then(() => pokeStationRender(env))
          .catch(() => {})
          .then(() => runDigestSend(env, Date.now()))
          .then((r) => {
            // Only log the runs that did something; a tick where nobody is due is pure noise.
            if (r.sent || r.failed || r.error || r.empty) {
              const failures = r.results
                .filter((x) => x.status === "failed")
                .map((x) => `${x.userId}:${x.error}`)
                .join(",");
              console.warn(
                `[digest] due=${r.due} stories=${r.storyCount} sent=${r.sent} failed=${r.failed}${r.empty ? " empty=1" : ""}${r.error ? ` error=${r.error}` : ""}${failures ? ` failures=${failures}` : ""}`,
              );
            }
          })
          .catch((e) => console.error(`[digest] failed: ${String(e)}`))
          // Last, and unconditionally — every step above already swallows its own failure, so
          // reaching here means the tick RAN, which is the claim /health's staleness check makes.
          // Deliberately outside reconcile(), which early-returns when POSTING_ENABLED isn't "true":
          // a paused feed must not read as a dead cron.
          .then(() => markCronTick(env, QUARTER_HOURLY_TICK_KEY)),
      );
    }
  },
  // Sequential ingestion consumer (wrangler.jsonc queues.consumers, max_concurrency=1). One batch runs
  // at a time across the whole queue, and each message is awaited in order below, so no two
  // processEvent() calls ever overlap — every near-dup lookup sees all prior committed stories.
  async queue(batch: MessageBatch<string>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const eventLog = new EventLog(env.DB);
    const seen = new SeenStore(env.DB);
    for (const msg of batch.messages) {
      const id = msg.body;
      try {
        const row = await eventLog.get(id); // raw_json + received_at, archived at ingest
        if (!row) {
          msg.ack(); // archived row pruned/gone — nothing to deliver
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(row.raw_json);
        } catch {
          msg.ack(); // non-JSON body: archived as error, never processable
          continue;
        }
        await processEvent(env, eventLog, seen, id, payload, row.received_at);
        msg.ack();
      } catch (e) {
        // Unexpected throw (e.g. D1). Record it for /inspect drift, then retry — idempotent +
        // seen-aware, so a redelivery just re-drives it. (A Slack failure does NOT throw here;
        // processEvent records failed>0 internally and returns, so those ack and heal via reconcile.)
        console.error(`[queue] processing failed for ${id}: ${String(e)}`);
        await eventLog.markProcessed(id, { decision: "error", error: String(e) }).catch(() => {});
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, string>;
