/**
 * Multi-channel fanout: one brief → N Slack channels (routing lives in `ops_state.routing`).
 * Uses the real D1 + a fetch mock that records the POSTed body, so we can assert WHICH channel each
 * chat.postMessage / chat.update went to.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processEvent } from "@/lib/process";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { saveRouting, type Routing } from "@/lib/routing";
import { storyKeyAt, storyKeyPrefix } from "@/lib/story";
import { sha256Hex } from "@/lib/ids";
import { replayArchivedEvents } from "@/lib/replay";

const DEFAULT_CH = "C_TEST"; // = SLACK_DEFAULT_CHANNEL in vitest.workers.config.ts
const VIC_CH = "C_VIC";
const RECEIVED_AT = 1783500000000;
const TITLE = "Premier announces election date";

/** Flat "Every Mention" payload. `source` is the saved-search name → picks the brief. */
function mention(o: { source: string; title?: string; outlet?: string; article: string }) {
  return {
    type: "Every Mention",
    providerType: "online_news",
    title: o.title ?? TITLE,
    statusLine: "🌐 480k Reach — 😐 Neutral Sentiment",
    source: o.source,
    keywords: "election",
    authorName: o.outlet ?? "The Age",
    text: "The premier has confirmed the date, reported today.",
    links: { article: o.article, source: "https://news.example.test/" },
  };
}

const vic = (o: Partial<Parameters<typeof mention>[0]> = {}) =>
  mention({ source: "Vic Election 2026", article: "https://vic.example/a", ...o });
const mps = (o: Partial<Parameters<typeof mention>[0]> = {}) =>
  mention({ source: "MPs", article: "https://mps.example/a", ...o });

interface Posted {
  method: string;
  channel?: string;
  ts?: string;
}

async function storyRows(): Promise<{ story_key: string; channel: string; slack_ts: string }[]> {
  const res = await env.DB.prepare("SELECT story_key, channel, slack_ts FROM stories ORDER BY story_key").all<{
    story_key: string;
    channel: string;
    slack_ts: string;
  }>();
  return res.results ?? [];
}

describe("multi-channel fanout (real D1 + mocked Slack)", () => {
  let posts: Posted[];
  /** Channels chat.postMessage should fail for, to simulate a partial fanout failure. */
  let failChannels: Set<string>;
  let nextTs: number;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    await env.DB.prepare("DELETE FROM ops_state").run();
    posts = [];
    failChannels = new Set();
    nextTs = 100;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split("/api/")[1] ?? String(url);
        const body = init?.body ? (JSON.parse(String(init.body)) as { channel?: string; ts?: string }) : {};
        posts.push({ method, channel: body.channel, ts: body.ts });
        if (method === "chat.postMessage" && body.channel && failChannels.has(body.channel)) {
          return Response.json({ ok: false, error: "channel_not_found" });
        }
        return Response.json({ ok: true, ts: `1783500000.000${nextTs++}` });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  const run = (id: string, payload: unknown, receivedAt = RECEIVED_AT) =>
    processEvent(env, new EventLog(env.DB), new SeenStore(env.DB), id, payload, receivedAt);

  const route = (briefs: Record<string, string[]>) =>
    saveRouting(env.DB, { v: 1, briefs, updatedAt: 0 } as Routing, RECEIVED_AT);

  const postsTo = () => posts.filter((p) => p.method === "chat.postMessage").map((p) => p.channel);

  it("with no routing saved, a brief posts only to the default channel", async () => {
    const summary = await run("e1", vic());
    expect(summary.posted).toBe(1);
    expect(postsTo()).toEqual([DEFAULT_CH]);
  });

  it("fans a routed brief out to every channel, one story row and one seen row per channel", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });

    const summary = await run("e1", vic());
    expect(summary.posted).toBe(2);
    expect(postsTo()).toEqual([DEFAULT_CH, VIC_CH]);

    const rows = await storyRows();
    expect(rows.map((r) => r.channel).sort()).toEqual([DEFAULT_CH, VIC_CH]);
    // Same title → same hash, different channel prefix; the instance suffix is the event's
    // received_at, so both keys are fully determined.
    expect(rows.map((r) => r.story_key).sort()).toEqual(
      [
        storyKeyAt(await storyKeyPrefix(DEFAULT_CH, TITLE), RECEIVED_AT),
        storyKeyAt(await storyKeyPrefix(VIC_CH, TITLE), RECEIVED_AT),
      ].sort(),
    );
    // Each channel got its own Slack ts, so a later merge updates the right message.
    expect(new Set(rows.map((r) => r.slack_ts)).size).toBe(2);

    const seen = await env.DB.prepare("SELECT count(*) AS n FROM seen_mentions").first<{ n: number }>();
    expect(seen?.n).toBe(2);
  });

  it("merges a same-title second outlet in BOTH channels, each into its own message", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    await run("e1", vic());
    const tsByChannel = Object.fromEntries((await storyRows()).map((r) => [r.channel, r.slack_ts]));
    posts = [];

    const summary = await run("e2", vic({ article: "https://vic.example/b", outlet: "Herald Sun" }));
    expect(summary.merged).toBe(2);
    expect(summary.posted).toBe(0);
    const updates = posts.filter((p) => p.method === "chat.update");
    expect(updates.map((u) => ({ channel: u.channel, ts: u.ts }))).toEqual([
      { channel: DEFAULT_CH, ts: tsByChannel[DEFAULT_CH] },
      { channel: VIC_CH, ts: tsByChannel[VIC_CH] },
    ]);
    expect(await storyRows()).toHaveLength(2); // still two stories, no new cards
  });

  it("treats an exact repeat as a duplicate in every channel, with no Slack calls", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    await run("e1", vic());
    posts = [];

    const summary = await run("e2", vic());
    expect(summary.duplicates).toBe(2);
    expect(summary.posted).toBe(0);
    expect(posts).toEqual([]);
  });

  it("a default-only brief sharing a headline merges into the default channel only", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    await run("e1", vic());
    posts = [];

    // Same title, different brief (MPs → unrouted → default channel). It folds into the DEFAULT
    // channel's story; the C_VIC card is untouched.
    const summary = await run("e2", mps());
    expect(summary.merged).toBe(1);
    expect(summary.posted).toBe(0);
    expect(posts.filter((p) => p.method === "chat.update").map((p) => p.channel)).toEqual([DEFAULT_CH]);
    expect(await storyRows()).toHaveLength(2);
  });

  it("leaves only the FAILED channel retryable after a partial fanout failure", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    failChannels.add(VIC_CH);

    const first = await run("e1", vic());
    expect(first.posted).toBe(1);
    expect(first.failed).toBe(1);
    expect(await storyRows()).toHaveLength(1); // only the default channel's story landed

    // Slack recovers; the reconcile re-drives the same event.
    failChannels.clear();
    posts = [];
    const second = await run("e1", vic());
    expect(second.posted).toBe(1);
    expect(second.duplicates).toBe(1); // the default channel is already `seen`
    expect(postsTo()).toEqual([VIC_CH]);
    expect((await storyRows()).map((r) => r.channel).sort()).toEqual([DEFAULT_CH, VIC_CH]);
  });

  it("carries the channel on each DocResult so /inspect can show it", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    const summary = await run("e1", vic());
    expect(summary.results.map((r) => r.channel)).toEqual([DEFAULT_CH, VIC_CH]);
  });

  it("honours routing saved between runs (the /inspect/routing save path)", async () => {
    await run("e1", vic());
    expect(postsTo()).toEqual([DEFAULT_CH]);

    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    posts = [];
    // A different article under the same brief now fans out.
    const summary = await run("e2", vic({ article: "https://vic.example/c", title: "A different headline" }));
    expect(summary.posted).toBe(2);
    expect(postsTo()).toEqual([DEFAULT_CH, VIC_CH]);
  });

  it("purgeOnly clears every configured channel, not just the default", async () => {
    await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });
    const historyFor: string[] = [];
    const deleted: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("conversations.history")) {
          const channel = new URL(u).searchParams.get("channel")!;
          historyFor.push(channel);
          return Response.json({ ok: true, messages: [{ ts: `1.${channel}`, bot_id: "B" }], response_metadata: {} });
        }
        deleted.push(JSON.parse(String(init!.body)).channel);
        return Response.json({ ok: true });
      }),
    );

    const res = await replayArchivedEvents(env, { purgeOnly: true });
    expect(historyFor).toEqual([DEFAULT_CH, VIC_CH]);
    expect(deleted).toEqual([DEFAULT_CH, VIC_CH]);
    expect(res.purged).toBe(2);
    expect(res.purgeNote).toContain(DEFAULT_CH);
    expect(res.purgeNote).toContain(VIC_CH);
  });

  describe("a headline that recurs outside the syndication window (migration 0011)", () => {
    const WEEK_LATER = RECEIVED_AT + 8 * 24 * 60 * 60 * 1000;

    it("posts a second card and KEEPS the first row, instead of orphaning it", async () => {
      // The pre-0011 bug: story_key was eternal but the merge lookup was windowed (72h), so a
      // repeat found nothing to merge into, posted a fresh card, then collided on INSERT — and
      // ON CONFLICT DO UPDATE repointed the row at the new message, cutting the old card loose
      // with nothing in D1 referencing it. That produced 16 of 17 orphans in production.
      await route({ "vic-election-2026": [DEFAULT_CH] });

      expect((await run("e1", vic())).posted).toBe(1);
      const first = await storyRows();
      expect(first).toHaveLength(1);

      // A DIFFERENT article carrying the same headline — which is how this arises in production
      // (a wire story rerun weeks later). Reusing the url would be caught by `seen` long before
      // the story lookup, and would test nothing.
      expect((await run("e2", vic({ article: "https://vic.example/b" }), WEEK_LATER)).posted).toBe(1);
      const both = await storyRows();

      // Two rows, two distinct Slack messages, and the ORIGINAL ts is still referenced — which is
      // exactly what keeps the first card out of the orphan sweep.
      expect(both).toHaveLength(2);
      expect(new Set(both.map((r) => r.slack_ts)).size).toBe(2);
      expect(both.map((r) => r.slack_ts)).toContain(first[0]!.slack_ts);
      // Same headline + channel ⇒ same prefix; only the instance suffix differs.
      const prefix = await storyKeyPrefix(DEFAULT_CH, TITLE);
      expect(both.every((r) => r.story_key.startsWith(`${prefix}|`))).toBe(true);
      expect(both.map((r) => r.story_key).sort()).toEqual(
        [storyKeyAt(prefix, RECEIVED_AT), storyKeyAt(prefix, WEEK_LATER)].sort(),
      );
    });

    it("still merges a repeat INSIDE the window into the existing card", async () => {
      // The fix must not cost us syndication merging — the whole point of the windowed lookup.
      await route({ "vic-election-2026": [DEFAULT_CH] });
      await run("e1", vic());
      const summary = await run("e2", vic({ outlet: "The Herald Sun", article: "https://heraldsun.test/x" }), RECEIVED_AT + 60_000);
      expect(summary.merged).toBe(1);
      expect(await storyRows()).toHaveLength(1); // folded in, no second row
    });

    it("picks the NEWEST card when several exist for the same headline", async () => {
      await route({ "vic-election-2026": [DEFAULT_CH] });
      await run("e1", vic());
      await run("e2", vic({ article: "https://vic.example/b" }), WEEK_LATER);
      const rows = await storyRows();
      const newest = rows.find((r) => r.story_key.endsWith(String(WEEK_LATER)))!;

      // A third mention an hour after the second must fold into the SECOND card, not the first.
      await run("e3", vic({ outlet: "The Herald Sun", article: "https://heraldsun.test/y" }), WEEK_LATER + 3_600_000);
      const updates = posts.filter((p) => p.method === "chat.update");
      expect(updates.at(-1)!.ts).toBe(newest.slack_ts);
    });
  });

  describe("legacy cutover (migration 0010)", () => {
    /** The pre-fanout state: a bare-hash story_key and a channel-less seen key. */
    async function seedLegacy(payload: ReturnType<typeof vic>, briefId: string) {
      const canonical = payload.links.article;
      const legacySeen = await sha256Hex(`${briefId}|${canonical}`);
      const bareKey = (await storyKeyPrefix(DEFAULT_CH, payload.title)).split("|")[1]!;
      await env.DB.prepare(
        `INSERT INTO stories (story_key, slack_ts, channel, brief_label, primary_mention_json, outlets_json,
           brief_labels_json, simhash, media_type, render_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      )
        .bind(
          bareKey,
          "1783500000.000001",
          DEFAULT_CH,
          "Vic Election 2026",
          JSON.stringify({}),
          JSON.stringify([{ name: "The Age", url: canonical, reach: 480000 }]),
          JSON.stringify(["Vic Election 2026"]),
          "online_news",
          RECEIVED_AT,
          RECEIVED_AT,
        )
        .run();
      await env.DB.prepare(`INSERT INTO seen_mentions (id, url, first_seen_at) VALUES (?, ?, ?)`)
        .bind(legacySeen, canonical, RECEIVED_AT)
        .run();
      return { bareKey, legacySeen };
    }

    /** Migration 0010's single statement. */
    const rekey = () =>
      env.DB.prepare("UPDATE stories SET story_key = channel || '|' || story_key WHERE story_key NOT LIKE '%|%'").run();

    it("re-keys legacy rows idempotently and doesn't repost them after cutover", async () => {
      const payload = vic();
      const { bareKey } = await seedLegacy(payload, "vic-election-2026");

      await rekey();
      await rekey(); // idempotent: the second pass must not double-prefix
      expect((await storyRows()).map((r) => r.story_key)).toEqual([`${DEFAULT_CH}|${bareKey}`]);

      // Reprocessing the same mention post-cutover is a duplicate on the strength of the LEGACY key.
      const summary = await run("e1", payload);
      expect(summary.duplicates).toBe(1);
      expect(summary.posted).toBe(0);
      expect(posts).toEqual([]);

      // …and it healed forward: the new per-channel key is now recorded too.
      const newKey = await sha256Hex(`vic-election-2026|${DEFAULT_CH}|${payload.links.article}`);
      const row = await env.DB.prepare("SELECT id FROM seen_mentions WHERE id = ?").bind(newKey).first();
      expect(row).not.toBeNull();
    });

    it("does NOT let the legacy key suppress a post to a NEWLY routed channel", async () => {
      const payload = vic();
      await seedLegacy(payload, "vic-election-2026");
      await rekey();
      await route({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });

      const summary = await run("e1", payload);
      expect(summary.duplicates).toBe(1); // default channel: legacy key hit
      expect(summary.posted).toBe(1); // C_VIC: never posted before
      expect(postsTo()).toEqual([VIC_CH]);
    });
  });
});
