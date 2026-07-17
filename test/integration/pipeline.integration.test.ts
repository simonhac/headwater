import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processEvent } from "@/lib/process";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";

function newsPayload(overrides: { url?: string; source?: string } = {}) {
  return {
    search_name: "Key People",
    documents: [
      {
        document_url: overrides.url ?? "https://x.example/a",
        document_title: "Renewable policy shift announced",
        source_name: overrides.source ?? "The Australian",
        source_information_type: "news",
        source_country_code: "AU",
        source_reach: 480000,
        document_opening_text: "A renewable policy shift, reported today.",
      },
    ],
  };
}

async function count(table: "stories" | "seen_mentions"): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function outletNames(): Promise<string[]> {
  const row = await env.DB.prepare("SELECT outlets_json FROM stories").first<{ outlets_json: string }>();
  return (JSON.parse(row!.outlets_json) as { name: string }[]).map((o) => o.name);
}

/**
 * A broadcast ("Every Mention") payload. `station` is a station-like `authorName` (digits/all-caps →
 * not a person → kept as the outlet, no station-resolve network) and `article` has no Meltwater
 * `/paywall/redirect/` id (so `stationCodeFor` returns null without fetching). Distinct `article`
 * → distinct dedupe key; the RFC air-time tail in `title` drives the air-time guard.
 */
function radioReading(o: { title: string; station: string; article: string; text: string; providerType?: string }) {
  return {
    type: "Every Mention",
    providerType: o.providerType ?? "tveyes_radio",
    title: o.title,
    statusLine: "🔊 55k Reach — 😐 Neutral Sentiment",
    source: "MPs",
    keywords: "MP",
    authorName: o.station,
    text: o.text,
    links: { article: o.article, source: "https://news.example.test/" },
  };
}

// The verbatim reading a syndicated radio bulletin carries across stations.
const READING =
  "Federal Independent MP Andrew Wilkie has accused the state government of rolling out the red carpet to a predatory industry by approving a new gambling licence to online bookmaker";

describe("processEvent (real D1 + mocked Slack)", () => {
  let calls: string[];

  beforeEach(async () => {
    // clean slate between tests
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        return Response.json({ ok: true, ts: "1783500000.000100" });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  const RECEIVED_AT = 1783500000000; // fixed webhook-receipt time for deterministic footer dates
  const run = (id: string, payload: unknown, receivedAt = RECEIVED_AT) =>
    processEvent(env, new EventLog(env.DB), new SeenStore(env.DB), id, payload, receivedAt);

  it("migrations applied: the tables exist", async () => {
    expect(await count("stories")).toBe(0);
    expect(await count("seen_mentions")).toBe(0);
  });

  it("posts a new story to Slack and records it in D1", async () => {
    const summary = await run("e1", newsPayload());
    expect(summary.posted).toBe(1);
    expect(calls.some((u) => u.includes("chat.postMessage"))).toBe(true);
    expect(await count("stories")).toBe(1);
    expect(await count("seen_mentions")).toBe(1);
  });

  it("drops an identical repeat as a duplicate (no second post)", async () => {
    await run("e1", newsPayload());
    calls = [];
    const summary = await run("e2", newsPayload());
    expect(summary.duplicates).toBe(1);
    expect(summary.posted).toBe(0);
    expect(calls.some((u) => u.includes("chat.postMessage"))).toBe(false);
    expect(await count("stories")).toBe(1); // still just the one story
  });

  it("folds a same-title different-outlet mention into the existing story (chat.update)", async () => {
    await run("e1", newsPayload());
    calls = [];
    const summary = await run("e3", newsPayload({ url: "https://y.example/b", source: "The Age" }));
    expect(summary.merged).toBe(1);
    expect(summary.posted).toBe(0);
    expect(calls.some((u) => u.includes("chat.update"))).toBe(true);
    expect(await count("stories")).toBe(1); // merged, not a new story

    const outlets = await env.DB.prepare("SELECT outlets_json FROM stories").first<{ outlets_json: string }>();
    const names = (JSON.parse(outlets!.outlets_json) as { name: string }[]).map((o) => o.name);
    expect(names).toEqual(["The Australian", "The Age"]);
  });

  it("broadcast: folds a same-reading segment from another station into one card (phrase overlap)", async () => {
    // Different program/airtime titles + different stations → same-title syndication misses; the
    // shared verbatim READING (despite different windowed lead-ins) makes it a phrase near-dup.
    const s1 = await run(
      "b1",
      radioReading({
        title: "Darren Kerwin - Wed, 08 Jul 2026 08:00:00 +1000",
        station: "98.9 7AD FM",
        article: "https://radio.example/a1",
        text: `the other end of the state his death prompted discussions around fatigue management for health workers ${READING}`,
      }),
    );
    expect(s1.posted).toBe(1);
    calls = [];
    const s2 = await run(
      "b2",
      radioReading({
        title: "Patty and Ravyn - Wed, 08 Jul 2026 08:30:00 +1000",
        station: "Sea FM 101.7",
        article: "https://radio.example/a2",
        text: `lincoln quilliam there enter his weapon for the event in the coming weeks held in march next year ${READING}`,
      }),
    );
    expect(s2.merged).toBe(1);
    expect(s2.posted).toBe(0);
    expect(calls.some((u) => u.includes("chat.update"))).toBe(true);
    expect(await count("stories")).toBe(1);
    expect(await outletNames()).toEqual(["98.9 7AD FM", "Sea FM 101.7"]);
  });

  it("broadcast: keeps a different bulletin that only shares a short stock phrase as its own story", async () => {
    await run(
      "b3",
      radioReading({
        title: "Breakfast - Wed, 08 Jul 2026 08:00:00 +1000",
        station: "98.9 7AD FM",
        article: "https://radio.example/b1",
        text: "the government defended its decision amid criticism that it was rolling out the red carpet to a predatory industry according to the opposition today",
      }),
    );
    const s2 = await run(
      "b4",
      radioReading({
        title: "Drive - Wed, 08 Jul 2026 09:00:00 +1000",
        station: "Sea FM 101.7",
        article: "https://radio.example/b2",
        text: "consumer advocates warned the policy risked rolling out the red carpet to a predatory industry and called for an urgent review by regulators",
      }),
    );
    expect(s2.posted).toBe(1); // only the ≤9-word clause overlaps → below minContiguousRun
    expect(s2.merged).toBe(0);
    expect(await count("stories")).toBe(2);
  });

  it("broadcast: never merges across media type (radio vs TV) even with identical transcript", async () => {
    await run(
      "b5",
      radioReading({
        title: "Darren Kerwin - Wed, 08 Jul 2026 08:00:00 +1000",
        station: "98.9 7AD FM",
        article: "https://radio.example/c1",
        text: READING,
      }),
    );
    const s2 = await run(
      "b6",
      radioReading({
        providerType: "tveyes_tv",
        title: "ABC News - Wed, 08 Jul 2026 08:30:00 +1000",
        station: "ABC TV Sydney",
        article: "https://radio.example/c2",
        text: READING,
      }),
    );
    expect(s2.posted).toBe(1); // media-type guard
    expect(await count("stories")).toBe(2);
  });

  it("broadcast: never merges when air-times are more than maxAirtimeGapHours apart", async () => {
    await run(
      "b7",
      radioReading({
        title: "Darren Kerwin - Wed, 08 Jul 2026 08:00:00 +1000",
        station: "98.9 7AD FM",
        article: "https://radio.example/d1",
        text: READING,
      }),
    );
    const s2 = await run(
      "b8",
      radioReading({
        title: "Evenings - Wed, 08 Jul 2026 13:00:00 +1000", // +5h > maxAirtimeGapHours (3)
        station: "Sea FM 101.7",
        article: "https://radio.example/d2",
        text: READING,
      }),
    );
    expect(s2.posted).toBe(1); // air-time guard, despite identical transcript
    expect(await count("stories")).toBe(2);
  });

  it("previews (no post) when POSTING is off — decide() → preview", async () => {
    const summary = await processEvent(
      { ...env, POSTING_ENABLED: "false" },
      new EventLog(env.DB),
      new SeenStore(env.DB),
      "e4",
      newsPayload(),
      RECEIVED_AT,
    );
    expect(summary.posted).toBe(0);
    expect(summary.results.some((r) => r.decision === "preview")).toBe(true);
    expect(calls.some((u) => u.includes("chat.postMessage"))).toBe(false);
  });
});
