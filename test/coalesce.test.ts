import { describe, it, expect, vi, afterEach } from "vitest";
import { clusterBroadcastStories, coalesceDuplicateStories } from "@/lib/coalesce";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import type { StoryRow } from "@/lib/story";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { Env } from "@/env";

const HOUR = 60 * 60 * 1000;

function mention(over: Partial<NormalizedMention> = {}): NormalizedMention {
  return {
    url: "https://example.com/a",
    outletUrl: null,
    // A broadcast title WITHOUT the "- <RFC air-time>" tail → airtimeMs() is null → the receipt-time
    // fallback (guard 2b) governs the temporal bound, which is exactly what we want to exercise.
    title: "Morning news segment",
    sourceName: "2GB",
    mediaType: "radio",
    countryCode: "AU",
    reach: 1000,
    sentiment: "neutral",
    publishedAt: null,
    snippet: "alpha beta gamma delta epsilon zeta",
    author: null,
    briefName: "MPs",
    imageUrl: null,
    matchedKeywords: [],
    raw: null,
    ...over,
  };
}

/** Build a broadcast story row. `simhash` is the stored decimal fingerprint; the primary snippet
 * drives the phrase sketch (kept disjoint across stories in these tests so SimHash alone decides). */
function row(fields: Partial<StoryRow>, primary: NormalizedMention = mention()): StoryRow {
  const outlets = [{ name: primary.sourceName ?? "Unknown", url: primary.url, reach: primary.reach }];
  return {
    story_key: fields.story_key ?? "k",
    slack_ts: fields.slack_ts ?? "1.1",
    channel: fields.channel ?? "C123",
    brief_label: "MPs",
    primary_mention_json: JSON.stringify(primary),
    outlets_json: fields.outlets_json ?? JSON.stringify(outlets),
    brief_labels_json: fields.brief_labels_json ?? JSON.stringify(["MPs"]),
    simhash: fields.simhash ?? "0",
    media_type: fields.media_type ?? primary.mediaType,
    render_hash: fields.render_hash ?? null,
    created_at: fields.created_at ?? 0,
    updated_at: fields.updated_at ?? 0,
  };
}

// A D1Database stub that records every .run() (so we can assert which rows were mutated/deleted) and
// serves rows per table: broadcastStoriesSince reads `stories`, loadDocIdStationNames reads the
// broadcast_stations⋈station_names join. Mirrors redecode.test.ts's fakeDB.
function fakeDB(opts: { stories?: StoryRow[]; docNames?: { doc_id: string; name: string }[] }) {
  const stories = opts.stories ?? [];
  const docNames = opts.docNames ?? [];
  const runs: { sql: string; args: unknown[] }[] = [];
  // A statement exposes .all()/.run()/.first() directly AND via .bind() — mirrors D1, whose loader
  // queries (no params) call prepare(sql).all() while parameterised ones call prepare(sql).bind(…).all().
  const stmt = (sql: string, args: unknown[]) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => {
      if (/FROM stories/.test(sql)) return { results: stories };
      if (/FROM broadcast_stations/.test(sql)) return { results: docNames };
      return { results: [] };
    },
    run: async () => {
      runs.push({ sql, args });
      return {};
    },
    first: async () => null,
  });
  return { _runs: runs, prepare: (sql: string) => stmt(sql, []) };
}

const okResp = (body: unknown) => ({ status: 200, headers: { get: () => null }, json: async () => body });

// Meltwater click-tracking wrapper (double-encoded `u=`), mirroring redecode.test.ts.
function trackingUrl(target: string): string {
  return `https://t.fake/v2/click?m=webhook&u=${encodeURIComponent(encodeURIComponent(target))}`;
}

/** A broadcast story whose raw payload carries station doc `docId` and a person-like `authorName` — so
 * its stored outlet name is the stale presenter, which re-resolution should upgrade to the station. */
function radioStory(fields: Partial<StoryRow>, docId: string, authorName: string): StoryRow {
  const raw = {
    providerType: "tveyes_radio",
    statusLine: "🔊 1M Reach",
    source: "MPs",
    authorName,
    text: "shared broadcast transcript sentence about the story that aired across stations",
    links: { source: trackingUrl(`https://transition.meltwater.com/paywall/redirect/${docId}`) },
  };
  return row({ ...fields, media_type: "radio" }, parseWebhookPayload(raw)[0]!);
}

describe("clusterBroadcastStories — star clustering (non-transitive)", () => {
  it("does NOT take the transitive closure: A~B and B~C but A≁C ⇒ {A:[B]}, C stands alone", () => {
    // Distinct fingerprints: hamming(A=0,B=7)=3 (≤max), hamming(B=7,C=63)=3, hamming(A=0,C=63)=6 (>max).
    // Disjoint snippets so the phrase path never fires — only SimHash decides. A union-find over this
    // predicate would merge all three (via B); the live engine (a star around the oldest anchor,
    // comparing later stories ONLY against anchors, never against folded dups) must keep C separate.
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 }, mention({ snippet: "a1 a2 a3 a4 a5 a6" }));
    const B = row({ story_key: "B", slack_ts: "2", simhash: "7", created_at: 1 * HOUR }, mention({ snippet: "b1 b2 b3 b4 b5 b6" }));
    const C = row({ story_key: "C", slack_ts: "3", simhash: "63", created_at: 2 * HOUR }, mention({ snippet: "c1 c2 c3 c4 c5 c6" }));

    const clusters = clusterBroadcastStories([A, B, C]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.canonical.story_key).toBe("A"); // oldest is canonical
    expect(clusters[0]!.dups.map((d) => d.story_key)).toEqual(["B"]);
  });

  it("folds a fast-path (identical SimHash) duplicate into the oldest anchor", () => {
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 });
    const B = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 1 * HOUR });
    const clusters = clusterBroadcastStories([A, B]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.canonical.story_key).toBe("A");
    expect(clusters[0]!.dups.map((d) => d.story_key)).toEqual(["B"]);
  });
});

describe("clusterBroadcastStories — coalesce-only guards", () => {
  it("guard 2b: air-time-less stories >windowHours apart do NOT merge (even with identical SimHash)", () => {
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 });
    const far = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 13 * HOUR }); // >12h
    expect(clusterBroadcastStories([A, far])).toHaveLength(0);

    const near = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 11 * HOUR }); // <12h
    expect(clusterBroadcastStories([A, near])).toHaveLength(1);
  });

  it("guard 4: stories in different channels do NOT merge", () => {
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", channel: "C1", created_at: 0 });
    const B = row({ story_key: "B", slack_ts: "2", simhash: "0", channel: "C2", created_at: 1 * HOUR });
    expect(clusterBroadcastStories([A, B])).toHaveLength(0);
  });
});

describe("coalesceDuplicateStories", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dryRun reports clusters and touches nothing (no Slack, no D1 writes)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 });
    const B = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 1 * HOUR });
    const db = fakeDB({ stories: [A, B] });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 168, dryRun: true, now: 100 * HOUR });
    expect(res.clusters).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.changes).toEqual([{ canonicalTs: "1", dupTs: ["2"], outlets: ["2GB"] }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(db._runs).toHaveLength(0);
  });

  it("real run: updates the canonical, then deletes duplicate messages + their rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResp({ ok: true, ts: "1.2" })));
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 });
    const B = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 1 * HOUR }, mention({ sourceName: "3AW", url: "https://example.com/b" }));
    const db = fakeDB({ stories: [A, B] });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 168, dryRun: false, now: 100 * HOUR });
    expect(res.updated).toBe(1);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
    // The merged card lists both outlets (raw is null here, so names fall back to the stored snapshot).
    expect(res.changes[0]!.outlets).toEqual(["2GB", "3AW"]);
    // The coalesced canonical (primary + outlets) was persisted BEFORE the delete; the dup row removed.
    expect(db._runs.filter((r) => /UPDATE stories SET primary_mention_json.*outlets_json/.test(r.sql))).toHaveLength(1);
    const deletes = db._runs.filter((r) => r.sql.includes("DELETE FROM stories"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args[0]).toBe("B");
    expect(fetch).toHaveBeenCalledTimes(2); // 1 update + 1 delete
  });

  it("partial failure: a failed delete keeps that row; the successful one is removed", async () => {
    let deleteCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("chat.update")) return okResp({ ok: true, ts: "1.2" });
        deleteCalls++;
        return okResp(deleteCalls === 1 ? { ok: true } : { ok: false, error: "cant_delete_message" });
      }),
    );
    const A = row({ story_key: "A", slack_ts: "1", simhash: "0", created_at: 0 });
    const B = row({ story_key: "B", slack_ts: "2", simhash: "0", created_at: 1 * HOUR });
    const C = row({ story_key: "C", slack_ts: "3", simhash: "0", created_at: 2 * HOUR });
    const db = fakeDB({ stories: [A, B, C] });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 168, dryRun: false, now: 100 * HOUR });
    expect(res.updated).toBe(1);
    expect(res.deleted).toBe(1); // only the first delete landed
    expect(res.failed).toBe(1); // the second delete failed → row kept
    const deletes = db._runs.filter((r) => r.sql.includes("DELETE FROM stories"));
    expect(deletes.map((d) => d.args[0])).toEqual(["B"]); // C's row NOT deleted (message still there)
  });

  it("re-resolves each member's station from the D1 map into the merged card outlets", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // Stored snapshots carry the stale presenter names (Ben Davis / Sabra Lane); the D1 map now names
    // their stations. The merged card must show the RESOLVED station names, not the presenters.
    const A = radioStory({ story_key: "A", slack_ts: "1", created_at: 0 }, "DOCA", "Ben Davis");
    const B = radioStory({ story_key: "B", slack_ts: "2", created_at: 1 * HOUR }, "DOCB", "Sabra Lane");
    const db = fakeDB({
      stories: [A, B],
      docNames: [
        { doc_id: "DOCA", name: "702 ABC Sydney" },
        { doc_id: "DOCB", name: "774 ABC Melbourne" },
      ],
    });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 0, dryRun: true, now: 100 * HOUR }); // hours:0 = day 0
    expect(res.clusters).toBe(1);
    expect(res.changes[0]!.outlets).toEqual(["702 ABC Sydney", "774 ABC Melbourne"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-resolves an already-merged extra outlet via its stored tracking url's docId", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const A = radioStory({ story_key: "A", slack_ts: "1", created_at: 0 }, "DOCA", "Ben Davis");
    // An extra outlet folded in via the live path — stored under a stale presenter name, but its url
    // still carries the station docId (DOCX), so re-resolution can recover the real station.
    const aOutlets = JSON.parse(A.outlets_json) as { name: string; url: string; reach: number | null }[];
    aOutlets.push({ name: "Stale Presenter", url: trackingUrl("https://transition.meltwater.com/paywall/redirect/DOCX"), reach: 500 });
    A.outlets_json = JSON.stringify(aOutlets);
    const B = radioStory({ story_key: "B", slack_ts: "2", created_at: 1 * HOUR }, "DOCB", "Sabra Lane");
    const db = fakeDB({
      stories: [A, B],
      docNames: [
        { doc_id: "DOCA", name: "702 ABC Sydney" },
        { doc_id: "DOCB", name: "774 ABC Melbourne" },
        { doc_id: "DOCX", name: "666 ABC Canberra" },
      ],
    });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 0, dryRun: true, now: 100 * HOUR });
    expect(res.changes[0]!.outlets).toContain("666 ABC Canberra");
    expect(res.changes[0]!.outlets).not.toContain("Stale Presenter");
  });

  it("caps total Slack calls per invocation and reports the remainder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResp({ ok: true, ts: "1.2" })));
    // 45 independent single-dup clusters: pairs 100h apart (guard 2b blocks cross-pair), each pair 1h
    // apart with identical SimHash (fast-match within the pair). 90 rows → 45 clusters, each = 1
    // update + 1 delete = 2 Slack calls. Budget 40 ⇒ 20 clusters processed, 25 remaining.
    const rows: StoryRow[] = [];
    for (let i = 0; i < 45; i++) {
      const base = i * 100 * HOUR;
      rows.push(row({ story_key: `a${i}`, slack_ts: `${i}.0`, simhash: "0", created_at: base }));
      rows.push(row({ story_key: `b${i}`, slack_ts: `${i}.1`, simhash: "0", created_at: base + 1 * HOUR }));
    }
    const db = fakeDB({ stories: rows });
    const env = { DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;

    const res = await coalesceDuplicateStories(env, { hours: 24 * 365, dryRun: false, now: 5000 * HOUR });
    expect(res.clusters).toBe(45);
    expect(res.updated).toBe(20);
    expect(res.deleted).toBe(20);
    expect(res.remaining).toBe(25);
    expect(fetch).toHaveBeenCalledTimes(40); // MAX_SLACK_CALLS_PER_CALL
  });
});
