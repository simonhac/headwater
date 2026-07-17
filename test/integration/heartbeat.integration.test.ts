import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runHeartbeat, LAST_ALERT_KEY } from "@/lib/heartbeat";
import { OpsState } from "@/lib/store/opsState";

const H = 60 * 60 * 1000;
const NOW = 1_783_600_000_000;

// Pin the stall threshold at 3h for these tests (the runtime DEFAULT is 24h). Keeps the 5h-stall
// cases below asserting the alert logic without depending on the default.
const hbEnv = { ...env, HEARTBEAT_MAX_SILENCE_HOURS: "3" } as typeof env;

// A processed real mention: `source` is populated, so the heartbeat counts it as ingestion.
async function logEventAt(receivedAt: number, id = `hb-${receivedAt}`) {
  await env.DB.prepare(
    `INSERT INTO webhook_events (id, received_at, source, raw_json, decision, posted) VALUES (?, ?, 'Test Outlet', '{}', 'logged', 0)`,
  )
    .bind(id, receivedAt)
    .run();
}

// A non-mention POST (empty-body probe / health ping): logged with no source. Must NOT count as
// ingestion — otherwise it would reset the stall clock and mask a genuine upstream outage.
async function logProbeAt(receivedAt: number, id = `probe-${receivedAt}`) {
  await env.DB.prepare(
    `INSERT INTO webhook_events (id, received_at, raw_json, decision, posted) VALUES (?, ?, '', 'error', 0)`,
  )
    .bind(id, receivedAt)
    .run();
}

describe("runHeartbeat (real D1 + mocked Slack)", () => {
  let calls: { url: string; body: any }[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM webhook_events").run();
    await env.DB.prepare("DELETE FROM ops_state").run();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ ok: true, ts: "1783500000.000200" });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const posted = () => calls.filter((c) => c.url.includes("chat.postMessage"));

  it("stays quiet when the feed is fresh", async () => {
    await logEventAt(NOW - 1 * H);
    const r = await runHeartbeat(hbEnv, NOW);
    expect(r.healthy).toBe(true);
    expect(r.alerted).toBe(false);
    expect(posted()).toHaveLength(0);
  });

  it("ignores non-mention POSTs — a recent empty-body probe does not mask a real stall", async () => {
    await logEventAt(NOW - 5 * H); // last real mention 5h ago → stalled
    await logProbeAt(NOW - 0.5 * H); // a probe 30m ago must NOT reset the clock
    const r = await runHeartbeat(hbEnv, NOW);
    expect(r.healthy).toBe(false);
    expect(r.alerted).toBe(true);
    expect(r.ageHours).toBeCloseTo(5); // measured from the last real mention, not the probe
    expect(r.latestMentionAt).toBe(NOW - 5 * H);
    expect(posted()).toHaveLength(1);
  });

  it("alerts once on a stall and records the marker, then suppresses within the window", async () => {
    await logEventAt(NOW - 5 * H); // 5h > 3h (pinned via hbEnv) threshold

    const first = await runHeartbeat(hbEnv, NOW);
    expect(first.alerted).toBe(true);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body.channel).toBe("C_TEST");
    expect(posted()[0]!.body.text).toMatch(/ingestion stalled/i);
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBe(NOW);

    // Same stall an hour later — inside the 6h re-alert window → no second page.
    const second = await runHeartbeat(hbEnv, NOW + 1 * H);
    expect(second.alerted).toBe(false);
    expect(second.suppressed).toBe(true);
    expect(posted()).toHaveLength(1);
  });

  it("re-alerts once the re-alert window elapses", async () => {
    await logEventAt(NOW - 5 * H);
    await runHeartbeat(hbEnv, NOW); // sets marker at NOW
    calls = [];
    const later = await runHeartbeat(hbEnv, NOW + 7 * H); // marker now 7h old > 6h window
    expect(later.alerted).toBe(true);
    expect(posted()).toHaveLength(1);
  });

  it("clears the marker once ingestion recovers, so the next stall alerts immediately", async () => {
    await logEventAt(NOW - 5 * H);
    await runHeartbeat(hbEnv, NOW); // alert + marker set
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBe(NOW);

    // A fresh event arrives → healthy → marker cleared.
    await logEventAt(NOW + 1 * H);
    const healthy = await runHeartbeat(hbEnv, NOW + 1 * H);
    expect(healthy.healthy).toBe(true);
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBeNull();
  });

  it("alerts when no events have ever been recorded", async () => {
    const r = await runHeartbeat(hbEnv, NOW);
    expect(r.alerted).toBe(true);
    expect(r.ageHours).toBeNull();
    expect(posted()[0]!.body.text).toMatch(/no events on record/i);
  });
});
