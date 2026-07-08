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

  const run = (id: string, payload: unknown) =>
    processEvent(env, new EventLog(env.DB), new SeenStore(env.DB), id, payload);

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

  it("previews (no post) when POSTING is off — decide() → preview", async () => {
    const summary = await processEvent(
      { ...env, POSTING_ENABLED: "false" },
      new EventLog(env.DB),
      new SeenStore(env.DB),
      "e4",
      newsPayload(),
    );
    expect(summary.posted).toBe(0);
    expect(summary.results.some((r) => r.decision === "preview")).toBe(true);
    expect(calls.some((u) => u.includes("chat.postMessage"))).toBe(false);
  });
});
