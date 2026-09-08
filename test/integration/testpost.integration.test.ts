/**
 * `POST /admin/test-post` — synthetic cards that follow the live routing.
 *
 * The point of the endpoint is to answer "did I tick the right boxes?", so the tests are mostly
 * about it agreeing with `channelsFor` in every state (routed, unrouted, muted) and about the two
 * safety properties: it doesn't post unless asked, and it never writes dedupe state.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { saveRouting } from "@/lib/routing";

const KEY = "test-replay-key";
const DEFAULT_CH = "C_TEST"; // matches vitest.workers.config.ts
const VIC_CH = "C_VIC0001";

interface Posted {
  channel?: string;
  attachments?: { title?: string; text?: string }[];
}

// `null` = send no Authorization header at all. (A default of KEY with an `undefined` argument
// would silently fall back to the valid key and turn the no-auth test into a happy-path one.)
async function call(qs: string, auth: string | null = KEY) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://feed.test/admin/test-post${qs}`, {
      method: "POST",
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    }),
    { ...env, REPLAY_KEY: KEY, POSTING_ENABLED: "true" },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /admin/test-post", () => {
  let posts: Posted[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ops_state").run();
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Posted);
        return Response.json({ ok: true, ts: `178350000${posts.length}.000100` });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to a dry run — the harmless spelling is the one you get by accident", async () => {
    const body = (await (await call("")).json()) as { dryRun: boolean; targets: unknown[] };
    expect(body.dryRun).toBe(true);
    expect(posts).toEqual([]);
    expect(body.targets.length).toBeGreaterThan(0); // still reports where each brief WOULD go
  });

  it("posts one card per routed channel, following the saved routing", async () => {
    await saveRouting(env.DB, { v: 1, briefs: { "vic-state": [DEFAULT_CH, VIC_CH] }, updatedAt: 0 }, Date.now());
    const body = (await (await call("?post=1&brief=vic-state")).json()) as {
      targets: { brief: string; channels: string[]; posted: { channel: string }[] }[];
    };
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]!.channels).toEqual([DEFAULT_CH, VIC_CH]);
    expect(body.targets[0]!.posted.map((p) => p.channel)).toEqual([DEFAULT_CH, VIC_CH]);
    expect(posts.map((p) => p.channel)).toEqual([DEFAULT_CH, VIC_CH]);
  });

  it("falls back to the default channel for a brief that was never routed", async () => {
    const body = (await (await call("?post=1&brief=mps")).json()) as { targets: { channels: string[] }[] };
    expect(body.targets[0]!.channels).toEqual([DEFAULT_CH]);
    expect(posts.map((p) => p.channel)).toEqual([DEFAULT_CH]);
  });

  it("posts nothing for a muted brief, and says so", async () => {
    await saveRouting(env.DB, { v: 1, briefs: { mps: [] }, updatedAt: 0 }, Date.now());
    const body = (await (await call("?post=1&brief=mps")).json()) as {
      targets: { muted: boolean; channels: string[] }[];
    };
    expect(body.targets[0]).toMatchObject({ muted: true, channels: [] });
    expect(posts).toEqual([]);
  });

  it("NEVER writes stories or seen rows — a test card must not swallow a real article", async () => {
    // A story row would let a later real article with the same title fold into the test card, and a
    // seen row would make the second test run silently do nothing.
    await call("?post=1");
    const stories = await env.DB.prepare("SELECT count(*) n FROM stories").first<{ n: number }>();
    const seen = await env.DB.prepare("SELECT count(*) n FROM seen_mentions").first<{ n: number }>();
    expect(stories?.n).toBe(0);
    expect(seen?.n).toBe(0);

    // ...so it is repeatable: a second run posts again rather than deduping itself away.
    const before = posts.length;
    await call("?post=1");
    expect(posts.length).toBe(before * 2);
  });

  it("covers every brief plus the synthesized 'unmatched' one when no brief is named", async () => {
    const body = (await (await call("")).json()) as { targets: { brief: string }[] };
    expect(body.targets.map((t) => t.brief)).toContain("default");
    expect(body.targets.map((t) => t.brief)).toContain("vic-election-2026");
  });

  it("marks the card as a test, so it can't be mistaken for a real mention", async () => {
    await call("?post=1&brief=mps");
    expect(posts[0]!.attachments?.[0]?.title).toContain("Headwater routing test");
  });

  it("requires the REPLAY_KEY bearer", async () => {
    expect((await call("?post=1", "wrong-key")).status).toBe(403);
    expect((await call("?post=1", null)).status).toBe(403);
    expect(posts).toEqual([]);
  });
});

describe("POST /admin/test-post?cleanup=1", () => {
  /** As Slack returns it: the posted 🧪 comes back as a `:test_tube:` shortcode. */
  const historyTitle = (label: string, tag: string) => `:test_tube: Headwater routing test — ${label} — ${tag}`;

  let deleted: { channel: string; ts: string }[];

  function stubHistory(messages: unknown[]) {
    deleted = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("conversations.history")) return Response.json({ ok: true, messages });
        if (u.includes("chat.delete")) {
          const b = JSON.parse(String(init?.body ?? "{}")) as { channel: string; ts: string };
          deleted.push(b);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: true, ts: "1.1" });
      }),
    );
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ops_state").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("matches the shortcode Slack returns, not the emoji we posted", async () => {
    // The whole cleanup hinges on this: a marker containing 🧪 matches on the way out and never on
    // the way back in, so cleanup would silently find nothing.
    stubHistory([{ ts: "1.1", bot_id: "B1", attachments: [{ title: historyTitle("MPs", "T1") }] }]);
    const body = (await (await call("?cleanup=1&post=1")).json()) as { matched: number; deleted: number };
    expect(body.matched).toBe(1);
    expect(body.deleted).toBe(1);
    expect(deleted).toEqual([{ channel: DEFAULT_CH, ts: "1.1" }]);
  });

  it("never deletes a real card, however orphaned", async () => {
    stubHistory([
      { ts: "1.1", bot_id: "B1", attachments: [{ title: historyTitle("MPs", "T1") }] },
      { ts: "2.2", bot_id: "B1", attachments: [{ title: "The Age: Pollies return to kitchen table" }] },
      { ts: "3.3", user: "U1", text: "a human message" },
    ]);
    await call("?cleanup=1&post=1");
    expect(deleted.map((d) => d.ts)).toEqual(["1.1"]);
  });

  it("narrows to a single run with tag=", async () => {
    stubHistory([
      { ts: "1.1", bot_id: "B1", attachments: [{ title: historyTitle("MPs", "2026-01-01T00:00:00Z") }] },
      { ts: "2.2", bot_id: "B1", attachments: [{ title: historyTitle("Teals", "2026-02-02T00:00:00Z") }] },
    ]);
    await call("?cleanup=1&post=1&tag=2026-02-02T00:00:00Z");
    expect(deleted.map((d) => d.ts)).toEqual(["2.2"]);
  });

  it("dry runs by default — reports matches, deletes nothing", async () => {
    stubHistory([{ ts: "1.1", bot_id: "B1", attachments: [{ title: historyTitle("MPs", "T1") }] }]);
    const body = (await (await call("?cleanup=1")).json()) as { matched: number; deleted: number };
    expect(body.matched).toBe(1);
    expect(body.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });
});
