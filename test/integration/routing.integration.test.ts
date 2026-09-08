/**
 * `/inspect/routing` — the brief→channel admin page. Drives the real Hono app so the Access gate,
 * the form POST parsing and the redirect are all exercised; `DEV_SKIP_ACCESS` is supplied per-request
 * so the un-authenticated 403 path can be tested too.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { loadRouting } from "@/lib/routing";
import { processEvent } from "@/lib/process";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";

const DEFAULT_CH = "C_TEST";
const VIC_CH = "C_VIC0001";

/** One `users.conversations` page. */
const page = (channels: unknown[], nextCursor = "") => ({
  ok: true,
  channels,
  response_metadata: { next_cursor: nextCursor },
});

async function call(path: string, init: RequestInit = {}, over: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://feed.test${path}`, init),
    { ...env, DEV_SKIP_ACCESS: "true", ...over },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const form = (pairs: [string, string][]) => {
  const body = new URLSearchParams();
  for (const [k, v] of pairs) body.append(k, v);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: body.toString(),
  };
};

describe("/inspect/routing", () => {
  let listPages: unknown[][];
  /** Every channel-listing request, so the test can assert WHICH method and HOW — not just that
   * something was called. Both have bitten us: a JSON body (silently ignored) and conversations.list
   * (a whole-workspace scan that returns ~2 rows per page) each render an empty picker with ok:true. */
  let listCalls: { url: string; method: string; params: Record<string, string> }[];
  /** Any call to the wrong listing method — conversations.list must never come back. */
  let wrongMethodCalls: string[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ops_state").run();
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    listCalls = [];
    wrongMethodCalls = [];
    // users.conversations returns ONLY the bot's memberships, and its rows are limited objects with
    // no `is_member` field — so the fixtures deliberately omit it. Filtering on it would drop every row.
    listPages = [
      [
        { id: DEFAULT_CH, name: "media-monitoring", is_private: false },
        { id: "C_OTHER001", name: "another-channel", is_private: false },
      ],
      [{ id: VIC_CH, name: "media-monitoring-vic-2026", is_private: true }],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("conversations.list")) {
          wrongMethodCalls.push(u);
          return Response.json(page([]));
        }
        if (u.includes("users.conversations")) {
          // These read methods take their args as QUERY PARAMS. A JSON body is silently ignored by
          // Slack (it answers ok:true from defaults), so read only the query here — a regression to
          // a POST body would surface as page 0 forever and an empty picker.
          const params = Object.fromEntries(new URL(u).searchParams);
          listCalls.push({ url: u, method: init?.method ?? "GET", params });
          const i = params.cursor ? Number(params.cursor) : 0;
          const next = i + 1 < listPages.length ? String(i + 1) : "";
          return Response.json(page(listPages[i]!, next));
        }
        return Response.json({ ok: true, ts: "1783500000.000100" });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("asks Slack for public AND private channels via query params, following the cursor", async () => {
    await call("/inspect/routing");
    expect(listCalls).toHaveLength(2); // page 1, then the next_cursor page
    expect(listCalls[0]!.method).toBe("GET");
    expect(listCalls[0]!.params).toEqual({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    expect(listCalls[1]!.params.cursor).toBe("1");
  });

  it("uses users.conversations, never conversations.list", async () => {
    // conversations.list enumerates the WHOLE workspace and filters client-side; on a large
    // workspace it hands back ~2 channels per page and never reaches the bot's own channels.
    await call("/inspect/routing");
    expect(wrongMethodCalls).toEqual([]);
  });

  it("names the fallback channel on unticked rows, rather than saying 'default channel'", async () => {
    // An unticked brief still posts; "→ default channel" read as "this brief goes nowhere".
    const html = await (await call("/inspect/routing")).text();
    expect(html).toContain("↳ posts to #media-monitoring");
    expect(html).not.toContain("→ default channel");
  });

  it("renders a column per member channel, following the cursor", async () => {
    const html = await (await call("/inspect/routing")).text();
    expect(html).toContain("#media-monitoring<");
    expect(html).toContain("#another-channel");
    expect(html).toContain("🔒 #media-monitoring-vic-2026"); // private, page 2 via next_cursor
    expect(html).toContain("default"); // the default channel's column is labelled
    // A checkbox per brief × channel, including the synthesized "unmatched" row.
    expect(html).toContain(`name="r.vic-election-2026" value="${VIC_CH}"`);
    expect(html).toContain(`name="r.default" value="${DEFAULT_CH}"`);
  });

  it("reports what Slack returned, so an empty picker is diagnosable in place", async () => {
    const html = await (await call("/inspect/routing")).text();
    expect(html).toContain("slack: 3 conversations over 2 page(s), 3 with the bot as a member");
  });

  it("saves a POSTed matrix, redirects, and pre-ticks it on the next render", async () => {
    const res = await call(
      "/inspect/routing",
      form([
        ["r.vic-election-2026", DEFAULT_CH],
        ["r.vic-election-2026", VIC_CH],
      ]),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/inspect/routing?saved=1");
    expect((await loadRouting(env.DB)).briefs).toEqual({ "vic-election-2026": [DEFAULT_CH, VIC_CH] });

    const html = await (await call("/inspect/routing?saved=1")).text();
    expect(html).toContain(`name="r.vic-election-2026" value="${VIC_CH}" checked`);
    expect(html).toContain("Routing saved.");
  });

  it("drops channels the bot isn't in, so a stale tab can't route into one", async () => {
    await call("/inspect/routing", form([["r.mps", "C_NOTAMEMBER"]]));
    expect((await loadRouting(env.DB)).briefs).toEqual({});
  });

  it("the saved routing takes effect on the very next processEvent", async () => {
    await call("/inspect/routing", form([["r.vic-election-2026", VIC_CH]]));
    const posts: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("chat.postMessage")) posts.push(JSON.parse(String(init!.body)).channel);
        return Response.json({ ok: true, ts: "1783500000.000100" });
      }),
    );
    const summary = await processEvent(
      env,
      new EventLog(env.DB),
      new SeenStore(env.DB),
      "e1",
      {
        type: "Every Mention",
        providerType: "online_news",
        title: "Premier announces election date",
        statusLine: "🌐 480k Reach — 😐 Neutral Sentiment",
        source: "Vic Election 2026",
        authorName: "The Age",
        text: "The premier has confirmed the date.",
        links: { article: "https://vic.example/a" },
      },
      1783500000000,
    );
    expect(summary.posted).toBe(1);
    expect(posts).toEqual([VIC_CH]); // NOT the default channel — the brief is routed away from it
  });

  it("rejects an unauthenticated GET and POST with 403", async () => {
    const noAccess = { DEV_SKIP_ACCESS: "false" };
    expect((await call("/inspect/routing", {}, noAccess)).status).toBe(403);
    expect((await call("/inspect/routing", form([["r.mps", DEFAULT_CH]]), noAccess)).status).toBe(403);
  });

  it("rejects a cross-site POST (CSRF guard) even with a valid Access session", async () => {
    const res = await call("/inspect/routing", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: "r.mps=" + DEFAULT_CH,
    });
    expect(res.status).toBe(403);
    expect((await loadRouting(env.DB)).briefs).toEqual({});
  });

  it("explains a missing_scope instead of rendering an empty table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "missing_scope" })));
    const html = await (await call("/inspect/routing")).text();
    expect(html).toContain("channels:read");
    expect(html).toContain("Reinstall to workspace");
  });
});
