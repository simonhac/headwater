import { Hono } from "hono";
import type { Env } from "@/env";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { processEvent } from "@/lib/process";
import { replayArchivedEvents } from "@/lib/replay";
import { redecodeRecentStories } from "@/lib/redecode";
import { eventId, timingSafeEqualStr } from "@/lib/ids";
import { renderInspectPage } from "@/ui/inspect";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import { runHeartbeat } from "@/lib/heartbeat";

const app = new Hono<{ Bindings: Env }>();

function checkKey(provided: string | undefined, expected: string | undefined): "ok" | "unconfigured" | "denied" {
  if (!expected) return "unconfigured";
  if (provided && timingSafeEqualStr(provided, expected)) return "ok";
  return "denied";
}

// --- health / status (no secrets leaked). Root "/" falls through to 404. ---
app.get("/health", async (c) => {
  let count = 0;
  try {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_events`).first<{ n: number }>();
    count = row?.n ?? 0;
  } catch {
    /* DB not migrated yet */
  }
  // Format-validate the runtime env (never leaks values). `configOk` is public; the detailed
  // issue list (still value-free) is gated behind the inspect key.
  const config = summarizeConfig(validateConfig(c.env));
  const showConfigDetail = checkKey(c.req.query("key"), c.env.INSPECT_KEY) === "ok";
  return c.json({
    service: "headwater",
    build: "headwater-6", // bump on each deploy to confirm the running code
    postingEnabled: c.env.POSTING_ENABLED === "true",
    events: count,
    configOk: config.ok,
    ...(showConfigDetail ? { configIssues: config.issues } : {}),
    configured: {
      webhookSecret: !!c.env.WEBHOOK_SHARED_SECRET,
      inspectKey: !!c.env.INSPECT_KEY,
      slackToken: !!c.env.SLACK_BOT_TOKEN,
      slackChannel: !!c.env.SLACK_DEFAULT_CHANNEL,
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
  await eventLog.append({
    id,
    receivedAt,
    raw,
    decision: parseError ? "error" : "logged",
    reason: parseError,
  });

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

// --- inspection (gated by ?key=) ---
app.get("/api/webhooks/recent", async (c) => {
  const gate = checkKey(c.req.query("key"), c.env.INSPECT_KEY);
  if (gate === "unconfigured") return c.text("INSPECT_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
  const events = await new EventLog(c.env.DB).recent(limit);
  return c.json(events);
});

// --- admin: reparse + repost the archived real webhooks (gated by REPLAY_KEY) ---
app.post("/admin/replay", async (c) => {
  const gate = checkKey(c.req.query("key"), c.env.REPLAY_KEY);
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
  const gate = checkKey(c.req.query("key"), c.env.REPLAY_KEY);
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

// --- admin: run the ingestion heartbeat on demand (same check the cron runs); gated by REPLAY_KEY ---
app.get("/admin/heartbeat", async (c) => {
  const gate = checkKey(c.req.query("key"), c.env.REPLAY_KEY);
  if (gate === "unconfigured") return c.text("REPLAY_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  return c.json(await runHeartbeat(c.env, Date.now()));
});

app.get("/inspect", async (c) => {
  const key = c.req.query("key");
  const gate = checkKey(key, c.env.INSPECT_KEY);
  if (gate === "unconfigured") return c.text("INSPECT_KEY not configured", 503);
  if (gate === "denied") return c.text("forbidden", 403);
  const PAGE_SIZE = 50;
  const beforeRaw = Number(c.req.query("before"));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const events = await new EventLog(c.env.DB).page(before, PAGE_SIZE);
  // A full page implies older history may exist; the cursor is the oldest row shown.
  const olderCursor = events.length === PAGE_SIZE ? events[events.length - 1]!.received_at : null;
  return c.html(
    renderInspectPage(events, `key=${encodeURIComponent(key ?? "")}`, { before, olderCursor }),
  );
});

// Cron trigger (wrangler.jsonc `triggers.crons`): the ingestion heartbeat. Never throw out of
// scheduled() — a rejected cron just retries noisily; the check self-reports via its return value.
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runHeartbeat(env, Date.now()).catch(() => {}));
  },
} satisfies ExportedHandler<Env>;
