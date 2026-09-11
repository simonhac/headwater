import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@/index";

// The default export is the Worker handler ({ fetch, scheduled, queue }), not the Hono app, so
// drive it the way Cloudflare does rather than reaching for app.request().
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const get = (path: string, e: typeof env) =>
  worker.fetch(new Request(`https://feed.moofer.com${path}`), e, ctx);

// The point of these: before 2026-09-12, /health caught a database failure and still returned 200
// with drift:null. An uptime monitor therefore stayed green through a dead D1 — the exact class of
// failure that made liveone's 2026-09-11 outage silent for 8h20m ("every check that watched LiveOne
// ran inside LiveOne"). A health endpoint that cannot fail is not a health endpoint.
describe("GET /health", () => {
  it("returns 200 and configOk when the database is readable", async () => {
    const res = await get("/health", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("headwater");
    expect(body.dbOk).toBe(true);
    expect(body).toHaveProperty("configOk");
    expect(body).toHaveProperty("drift");
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dbOk).toBe(false);
    // Still a full body, not an error page: the monitor asserts on "configOk":true, so the shape
    // has to survive the failure for the assertion to be meaningful rather than merely absent.
    expect(body.service).toBe("headwater");
    expect(body.drift).toBeNull();
  });

  it("leaks no secret values", async () => {
    // The repo is PUBLIC and channel ids are treated as secret. `configured` is booleans only.
    const res = await get("/health", env);
    const body = (await res.json()) as Record<string, unknown>;
    const configured = body.configured as Record<string, unknown>;
    for (const v of Object.values(configured)) expect(typeof v).toBe("boolean");
    expect(typeof body.channels).toBe("number");
    expect(JSON.stringify(body)).not.toContain("xoxb-");
  });
});
