import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "@/index";
import { HOURLY_TICK_KEY, QUARTER_HOURLY_TICK_KEY } from "@/lib/health";

// The default export is the Worker handler ({ fetch, scheduled, queue }), not the Hono app, so
// drive it the way Cloudflare does rather than reaching for app.request().
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const get = (path: string, e: typeof env) =>
  worker.fetch(new Request(`https://feed.moofer.com${path}`), e, ctx);

// The point of these: before 2026-09-12, /health caught a database failure and still returned 200
// with drift:null. An uptime monitor therefore stayed green through a dead D1 — the exact class of
// failure that made liveone's 2026-09-11 outage silent for 8h20m ("every check that watched LiveOne
// ran inside LiveOne"). A health endpoint that cannot fail is not a health endpoint.
const MIN = 60 * 1000;
const H = 60 * MIN;

/** Record a cron tick `agoMs` in the past — the marker /health asserts freshness on. */
const tick = (key: string, agoMs: number) =>
  env.DB.prepare(`INSERT OR REPLACE INTO ops_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(key, String(Date.now() - agoMs), Date.now() - agoMs)
    .run();

/** An archived event, `agoMs` old, at an explicit decision — 'logged' is what append() writes and
 *  what an event that never finished processing is still sitting at. */
const event = (id: string, agoMs: number, decision: string, source: string | null) =>
  env.DB.prepare(
    `INSERT OR REPLACE INTO webhook_events (id, received_at, source, raw_json, parsed_json, decision, posted)
     VALUES (?, ?, ?, '{}', NULL, ?, 0)`,
  )
    .bind(id, Date.now() - agoMs, source, decision)
    .run();

const healthy = async () => {
  await tick(HOURLY_TICK_KEY, 10 * MIN);
  await tick(QUARTER_HOURLY_TICK_KEY, 5 * MIN);
  await event("ok-1", 20 * MIN, "posted", "Test Outlet");
};

const body = async (res: Response) => (await res.json()) as Record<string, any>;

describe("GET /health", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM webhook_events`).run();
    await env.DB.prepare(`DELETE FROM ops_state`).run();
  });

  it("returns 200 and configOk when the database is readable", async () => {
    await healthy();
    const res = await get("/health", env);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.service).toBe("headwater");
    expect(b.dbOk).toBe(true);
    expect(b).toHaveProperty("configOk");
    expect(b).toHaveProperty("drift");
    for (const [name, check] of Object.entries(b.checks as Record<string, { ok: boolean }>)) {
      expect(check.ok, `${name} should be ok`).toBe(true);
    }
  });

  it("still returns 200 on a virgin database, so a fresh deploy never pages", async () => {
    // No markers, no events: absence is not evidence of a fault. Only staleness is.
    const res = await get("/health", env);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.checks.hourly.ageMinutes).toBeNull();
    expect(b.checks.feed.ageHours).toBeNull();
  });

  it("returns 503 when the quarter-hourly cron has stopped ticking", async () => {
    await healthy();
    await tick(QUARTER_HOURLY_TICK_KEY, 90 * MIN);
    const res = await get("/health", env);
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.checks.quarterHourly.ok).toBe(false);
    expect(b.checks.hourly.ok).toBe(true); // the diagnosis is in the body, not the status code
    // The full body must survive the failure — the uptime monitor asserts on the literal
    // "configOk":true, so if the shape collapsed the check would degrade to "the body changed"
    // instead of "the feed is broken".
    expect(b.service).toBe("headwater");
    expect(b).toHaveProperty("configOk");
    expect(b.drift).not.toBeNull();
  });

  it("returns 503 when the hourly cron has stopped ticking", async () => {
    await healthy();
    await tick(HOURLY_TICK_KEY, 3 * H);
    const res = await get("/health", env);
    expect(res.status).toBe(503);
    expect((await body(res)).checks.hourly.ok).toBe(false);
  });

  it("returns 503 when events arrive but never finish processing", async () => {
    await tick(HOURLY_TICK_KEY, 10 * MIN);
    await tick(QUARTER_HOURLY_TICK_KEY, 5 * MIN);
    await event("processed-earlier", 3 * H, "posted", "Test Outlet");
    await event("stuck-1", 50 * MIN, "logged", null); // arrived since, never processed
    const res = await get("/health", env);
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.checks.processing).toMatchObject({ ok: false, unprocessed: 1 });
    // Arrival is recent, processing is not: exactly the pair that tells a broken pipeline apart
    // from a silent upstream.
    expect(b.lastReceivedAt).toBeGreaterThan(b.lastProcessedAt);
  });

  it("ignores an event that is merely young, or long past the window", async () => {
    await healthy();
    await event("fresh", 2 * MIN, "logged", null); // still inside the settle grace
    await event("ancient", 40 * 24 * H, "logged", null); // aged out of the 24h window
    const res = await get("/health", env);
    expect(res.status).toBe(200);
    expect((await body(res)).checks.processing.unprocessed).toBe(0);
  });

  it("returns 503 when the feed has gone quiet past the threshold", async () => {
    await tick(HOURLY_TICK_KEY, 10 * MIN);
    await tick(QUARTER_HOURLY_TICK_KEY, 5 * MIN);
    await event("old-mention", 30 * H, "posted", "Test Outlet");
    const res = await get("/health", env);
    expect(res.status).toBe(503);
    expect((await body(res)).checks.feed.ok).toBe(false);
  });

  it("returns 503 for a failure older than the window reconcile could heal it in", async () => {
    await healthy();
    await event("dead-letter", 80 * H, "error", null);
    const res = await get("/health", env);
    expect(res.status).toBe(503);
    expect((await body(res)).checks.failures).toMatchObject({ ok: false, stuck: 1 });
  });

  it("does not fail on a recent failure, which reconcile is still expected to heal", async () => {
    await healthy();
    await event("healable", 2 * H, "error", null);
    const res = await get("/health", env);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.checks.failures.ok).toBe(true);
    expect(b.drift.errors).toBe(1); // visible as drift, just not asserted on
  });

  it("returns 503 when the database is unreadable", async () => {
    // A DB binding whose prepare() throws, standing in for D1 being down or unmigrated.
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: webhook_events");
        },
      },
    } as unknown as typeof env;

    const res = await get("/health", broken);
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.dbOk).toBe(false);
    // Still a full body, not an error page: the monitor asserts on "configOk":true, so the shape
    // has to survive the failure for the assertion to be meaningful rather than merely absent.
    expect(b.service).toBe("headwater");
    expect(b.drift).toBeNull();
    expect(b.checks).toBeNull();
  });

  it("leaks no secret values", async () => {
    // The repo is PUBLIC and channel ids are treated as infrastructure detail, not just the tokens.
    // An earlier version of this test only grepped for "xoxb-", which would have missed a leaked
    // channel id or webhook secret entirely — so assert against the ACTUAL configured
    // values, which is the only form of this check that can fail for the right reason.
    const secretEnv = {
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test-token-value",
      SLACK_DEFAULT_CHANNEL: "C0SECRETCHANNEL",
      WEBHOOK_SHARED_SECRET: "webhook-shared-secret-value",
      REPLAY_KEY: "replay-key-value",
      ACCESS_AUD: "access-aud-value",
    } as unknown as typeof env;

    const res = await get("/health", secretEnv);
    const raw = await res.text();
    for (const secret of [
      "xoxb-test-token-value",
      "C0SECRETCHANNEL",
      "webhook-shared-secret-value",
      "replay-key-value",
      "access-aud-value",
    ]) {
      expect(raw, `/health leaked ${secret}`).not.toContain(secret);
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const configured = parsed.configured as Record<string, unknown>;
    for (const v of Object.values(configured)) expect(typeof v).toBe("boolean");
    expect(typeof parsed.channels).toBe("number");
  });

  // Without this, the whole scheme could be inert and still look green — which is precisely how the
  // heartbeats it replaced spent their entire life in `pending`, indistinguishable from healthy.
  it("scheduled() records the tick markers /health asserts on", async () => {
    const run = async (cron: string) => {
      let pending: Promise<unknown> | undefined;
      const scheduledCtx = {
        waitUntil: (p: Promise<unknown>) => {
          pending = p;
        },
        passThroughOnException() {},
      } as unknown as ExecutionContext;
      await worker.scheduled({ scheduledTime: Date.now(), cron, noRetry() {} } as ScheduledController, env, scheduledCtx);
      await pending;
    };

    const marker = async (key: string) =>
      (await env.DB.prepare(`SELECT value FROM ops_state WHERE key = ?`).bind(key).first<{ value: string }>())?.value;

    expect(await marker(HOURLY_TICK_KEY)).toBeUndefined();
    await run("0 * * * *");
    await run("*/15 * * * *");

    for (const key of [HOURLY_TICK_KEY, QUARTER_HOURLY_TICK_KEY]) {
      const v = await marker(key);
      expect(v, `${key} was never written`).toBeDefined();
      expect(Date.now() - Number(v)).toBeLessThan(60 * 1000);
    }

    // And the endpoint reads them as fresh.
    const res = await get("/health", env);
    const b = await body(res);
    expect(b.checks.hourly.ok).toBe(true);
    expect(b.checks.quarterHourly.ok).toBe(true);
  });
});
