import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { processEvent } from "@/lib/process";
import { replayArchivedEvents } from "@/lib/replay";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";

const fetchCtx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

// Fixed webhook-receipt time; the reconcile window in each test is set around it (deterministic —
// no Date.now()). Rows sit inside [RECEIVED_AT - 1000, RECEIVED_AT + 1000).
const RECEIVED_AT = 1783500000000;

/**
 * A NEWS "Every Mention" payload (the real flat shape). Crucially, replay only reprocesses this
 * shape — the synthetic `documents[]` shape is skipped — so reconcile tests MUST use it. `source`
 * is the brief ("MPs"); the outlet comes from `authorName`; `providerType` is non-broadcast so no
 * station-resolve network fetch fires. Same `title` → same story (merges); distinct `title` → new
 * story.
 */
function everyMention(o: { title: string; article: string; author?: string }) {
  return {
    type: "Every Mention",
    providerType: "online_news",
    title: o.title,
    statusLine: "📰 480k Reach — 😐 Neutral Sentiment",
    source: "MPs",
    keywords: "MP, Kate Chaney",
    authorName: o.author ?? "The Australian",
    text: "Independent MP Kate Chaney is calling on the government.",
    links: { article: o.article, source: "https://news.example.test/" },
  };
}

async function count(table: "stories" | "seen_mentions" | "webhook_events" | "broadcast_stations"): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A radio ("Every Mention") payload whose `links.article` carries a resolvable Meltwater doc id, so
 * station resolution runs (and caches a `broadcast_stations` row) on first processing. */
function radioMention(o: { title: string; docId: string }) {
  const paywall = `https://app.meltwater.com/paywall/redirect/${o.docId}`;
  return {
    type: "Every Mention",
    providerType: "tveyes_radio",
    title: o.title,
    statusLine: "🔊 55k Reach — 😐 Neutral Sentiment",
    source: "MPs",
    keywords: "MP",
    authorName: "Ben Davis",
    text: "Radio segment mentioning an MP.",
    links: { article: `https://t.notifications.example/v2/x?m=webhook&u=${encodeURIComponent(paywall)}`, source: "https://news.example.test/" },
  };
}

async function eventRow(id: string) {
  return env.DB.prepare("SELECT decision, posted, slack_ts, parsed_json FROM webhook_events WHERE id = ?")
    .bind(id)
    .first<{ decision: string; posted: number; slack_ts: string | null; parsed_json: string | null }>();
}

async function outletNames(): Promise<string[]> {
  const row = await env.DB.prepare("SELECT outlets_json FROM stories").first<{ outlets_json: string }>();
  return (JSON.parse(row!.outlets_json) as { name: string }[]).map((o) => o.name);
}

describe("reconcile + hardening (real D1 + mocked Slack)", () => {
  let calls: string[];
  // When set, the Slack method whose name starts with this string returns { ok:false } (simulated failure).
  let failMethod: string | null;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    await env.DB.prepare("DELETE FROM webhook_events").run();
    calls = [];
    failMethod = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        const method = u.split("/api/")[1] ?? "";
        if (failMethod && method.startsWith(failMethod)) {
          return Response.json({ ok: false, error: "simulated_failure" });
        }
        return Response.json({ ok: true, ts: "1783500000.000100" });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Archive one event AND run it through the pipeline — mirrors production ingestion. */
  const seed = async (id: string, payload: unknown, receivedAt = RECEIVED_AT) => {
    const log = new EventLog(env.DB);
    await log.append({ id, receivedAt, raw: JSON.stringify(payload), decision: "logged" });
    return processEvent(env, log, new SeenStore(env.DB), id, payload, receivedAt);
  };

  const postCount = () => calls.filter((u) => u.includes("chat.postMessage")).length;
  const WINDOW = { sinceMs: RECEIVED_AT - 1000, untilMs: RECEIVED_AT + 1000 };

  it("P0-1: a failed merge stays un-seen and is not counted, then heals on a later run", async () => {
    const a = everyMention({ title: "Policy shift announced", article: "https://x.example/a", author: "The Australian" });
    const b = everyMention({ title: "Policy shift announced", article: "https://x.example/b", author: "The Age" });

    await seed("a1", a);
    expect(await count("seen_mentions")).toBe(1);

    // Same title, different outlet+url → merge path. Force chat.update to fail.
    failMethod = "chat.update";
    const s = await seed("a2", b);
    expect(s.merged).toBe(0);
    expect(s.failed).toBe(1);
    expect(await count("seen_mentions")).toBe(1); // NOT marked seen — the G1 fix
    expect(await outletNames()).toEqual(["The Australian"]); // outlets untouched

    // Later run with Slack healthy → the outlet is folded in.
    failMethod = null;
    const log = new EventLog(env.DB);
    const s2 = await processEvent(env, log, new SeenStore(env.DB), "a2", b, RECEIVED_AT);
    expect(s2.merged).toBe(1);
    expect(await count("seen_mentions")).toBe(2);
    expect(await outletNames()).toEqual(["The Australian", "The Age"]);
  });

  it("P0-2: a windowed reconcile does not corrupt already-delivered rows", async () => {
    await seed("e1", everyMention({ title: "Story one", article: "https://x.example/1" }));
    await seed("e2", everyMention({ title: "Story two", article: "https://x.example/2" }));
    expect(await count("stories")).toBe(2);

    const before1 = await eventRow("e1");
    const before2 = await eventRow("e2");
    expect(before1!.decision).toBe("posted");
    expect(before1!.posted).toBe(1);

    calls = [];
    const res = await replayArchivedEvents(env, WINDOW);
    expect(res.events).toBe(2);
    expect(res.posted).toBe(0);
    expect(postCount()).toBe(0); // nothing re-posted
    expect(await count("stories")).toBe(2);

    // Rows are preserved verbatim — decision, posted, slack_ts, and (load-bearing) parsed_json.
    for (const [b, a] of [
      [before1, await eventRow("e1")],
      [before2, await eventRow("e2")],
    ] as const) {
      expect(a!.decision).toBe("posted");
      expect(a!.posted).toBe(1);
      expect(a!.slack_ts).toBe(b!.slack_ts);
      expect(a!.parsed_json).toBe(b!.parsed_json);
    }
  });

  it("P0-2: reconcile re-posts only the un-posted straggler and leaves the rest untouched", async () => {
    await seed("h1", everyMention({ title: "Delivered story", article: "https://x.example/ok" }));

    // Straggler: its post fails → un-seen, decision 'error', posted 0.
    failMethod = "chat.postMessage";
    const s = await seed("h2", everyMention({ title: "Stuck story", article: "https://x.example/stuck" }));
    expect(s.posted).toBe(0);
    expect(s.failed).toBe(1);
    expect(await count("stories")).toBe(1);
    expect(await count("seen_mentions")).toBe(1);
    const stuckBefore = await eventRow("h2");
    expect(stuckBefore!.decision).toBe("error");
    expect(stuckBefore!.posted).toBe(0);

    // Reconcile with Slack healthy → exactly the straggler re-posts.
    failMethod = null;
    calls = [];
    const res = await replayArchivedEvents(env, WINDOW);
    expect(res.events).toBe(2);
    expect(res.posted).toBe(1);
    expect(postCount()).toBe(1);
    expect(await count("stories")).toBe(2);
    expect(await count("seen_mentions")).toBe(2);

    const stuckAfter = await eventRow("h2");
    expect(stuckAfter!.decision).toBe("posted");
    expect(stuckAfter!.posted).toBe(1);
  });

  it("P0-2: the reconcile window excludes events outside [since, until)", async () => {
    // One event inside the window, one well outside (too new — inside the settle buffer).
    await seed("w1", everyMention({ title: "In window", article: "https://x.example/in" }), RECEIVED_AT);
    await seed("w2", everyMention({ title: "Too new", article: "https://x.example/new" }), RECEIVED_AT + 10_000);

    calls = [];
    const res = await replayArchivedEvents(env, WINDOW);
    expect(res.events).toBe(1); // only w1 falls in [RECEIVED_AT-1000, RECEIVED_AT+1000)
  });

  it("P1-2: driftCounts + failures surface an undelivered event", async () => {
    await seed("ok1", everyMention({ title: "Delivered", article: "https://x.example/ok" }));
    failMethod = "chat.postMessage";
    await seed("bad1", everyMention({ title: "Broke", article: "https://x.example/bad" }));

    const log = new EventLog(env.DB);
    const drift = await log.driftCounts(RECEIVED_AT - 1000);
    expect(drift.errors).toBe(1); // bad1 is decision='error'
    expect(drift.unposted).toBe(1); // bad1 has $.failed = 1

    const failed = await log.failures(RECEIVED_AT - 1000, null, 50);
    expect(failed.map((e) => e.id)).toEqual(["bad1"]); // only the undelivered event
    expect(await log.failuresCount(RECEIVED_AT - 1000)).toBe(1); // badge matches the list
  });

  it("P1-2: a benign zero-mention payload is NOT counted as drift", async () => {
    const log = new EventLog(env.DB);
    // An empty batch (e.g. a Meltwater verification ping) parses to zero mentions.
    await log.append({ id: "empty1", receivedAt: RECEIVED_AT, raw: "[]", decision: "logged" });
    const s = await processEvent(env, log, new SeenStore(env.DB), "empty1", [], RECEIVED_AT);
    expect(s.total).toBe(0);
    expect((await eventRow("empty1"))!.decision).toBe("logged"); // nothing to deliver

    const drift = await log.driftCounts(RECEIVED_AT - 1000);
    expect(drift.unposted).toBe(0); // not drift — no un-delivered mention
    expect(drift.errors).toBe(0);
    expect(await log.failuresCount(RECEIVED_AT - 1000)).toBe(0);
  });

  it("P1-2: a partial-failure event (headline posts, syndicated update fails) shows as drift", async () => {
    const log = new EventLog(env.DB);
    // Two same-title docs: doc 1 posts a new story, doc 2 merges into it — but chat.update fails.
    const payload = {
      search_name: "Key People",
      documents: [
        { document_url: "https://x.example/p1", document_title: "Shared headline", source_name: "The Australian", source_information_type: "news", source_country_code: "AU", source_reach: 480000, document_opening_text: "Text." },
        { document_url: "https://x.example/p2", document_title: "Shared headline", source_name: "The Age", source_information_type: "news", source_country_code: "AU", source_reach: 300000, document_opening_text: "Text." },
      ],
    };
    await log.append({ id: "part1", receivedAt: RECEIVED_AT, raw: JSON.stringify(payload), decision: "logged" });
    failMethod = "chat.update";
    const s = await processEvent(env, log, new SeenStore(env.DB), "part1", payload, RECEIVED_AT);
    expect(s.posted).toBe(1); // headline delivered
    expect(s.failed).toBe(1); // the syndicated outlet did not
    expect((await eventRow("part1"))!.decision).toBe("posted"); // event reads as posted...

    const drift = await log.driftCounts(RECEIVED_AT - 1000);
    expect(drift.unposted).toBe(1); // ...yet the undelivered outlet is surfaced (not hidden)
  });

  it("admin: a reset replay rebuilds processing state and can downgrade a now-failing event", async () => {
    await seed("r1", everyMention({ title: "Was delivered", article: "https://x.example/r1" }));
    expect((await eventRow("r1"))!.decision).toBe("posted");

    // Reprocess under reset with Slack now failing → the row must DOWNGRADE, not keep stale 'posted'.
    failMethod = "chat.postMessage";
    await replayArchivedEvents(env, { reset: true });
    const after = await eventRow("r1");
    expect(after!.posted).toBe(0);
    expect(after!.decision).toBe("error");
  });

  it("admin: a reset replay preserves an un-parseable event's error signal", async () => {
    // A non-JSON body is archived as decision='error' and can never be reprocessed (JSON.parse throws).
    await new EventLog(env.DB).append({ id: "bad", receivedAt: RECEIVED_AT, raw: "<<not json>>", decision: "error", reason: "non_json_body" });
    await replayArchivedEvents(env, { reset: true });
    // The reset blank must skip it — otherwise its error signal is erased with nothing to recompute it.
    expect((await eventRow("bad"))!.decision).toBe("error");
  });

  it("reconcile does NOT re-resolve the station for an already-seen broadcast item", async () => {
    await seed("radio1", radioMention({ title: "Radio segment", docId: "DOC123" }));
    expect(await count("broadcast_stations")).toBe(1); // first processing cached the code

    // Clear the code cache, then reconcile. A now-`seen` broadcast must be skipped before station
    // resolution — otherwise it re-hits the transition fetch (and, in prod, re-launches Browser
    // Rendering) on every 15-min tick. So the cache row must stay gone.
    await env.DB.prepare("DELETE FROM broadcast_stations").run();
    await replayArchivedEvents(env, WINDOW);
    expect(await count("broadcast_stations")).toBe(0);
  });

  it("P1-2: /health exposes the drift gauge JSON", async () => {
    const now = Date.now();
    await seed("okn", everyMention({ title: "Delivered now", article: "https://x.example/okn" }), now);
    failMethod = "chat.postMessage";
    await seed("badn", everyMention({ title: "Broke now", article: "https://x.example/badn" }), now);

    const res = await worker.fetch(new Request("http://local/health"), env, fetchCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drift: { errors: number; unposted: number } | null };
    expect(body.drift).not.toBeNull();
    expect(body.drift!.errors).toBeGreaterThanOrEqual(1);
    expect(body.drift!.unposted).toBeGreaterThanOrEqual(1);
  });

  it("P0-2: scheduled() runs the reconcile and heals the straggler", async () => {
    const recent = Date.now() - 20 * 60 * 1000; // inside [now-72h, now-15min)
    await seed("sc1", everyMention({ title: "Delivered", article: "https://x.example/scok" }), recent);
    failMethod = "chat.postMessage";
    await seed("sc2", everyMention({ title: "Stuck", article: "https://x.example/scstuck" }), recent);

    failMethod = null;
    calls = [];
    let pending: Promise<unknown> | undefined;
    const scheduledCtx = { waitUntil: (p: Promise<unknown>) => { pending = p; }, passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as ScheduledController, env, scheduledCtx);
    await pending; // let the backgrounded reconcile finish

    expect(calls.filter((u) => u.includes("chat.postMessage")).length).toBe(1); // only sc2 re-posted
    const stuck = await eventRow("sc2");
    expect(stuck!.decision).toBe("posted");
  });
});
