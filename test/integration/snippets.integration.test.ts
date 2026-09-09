/**
 * `POST /admin/repair-snippets` — backfill for snippets Meltwater cut mid-sentence.
 *
 * The cases that matter are the ones `/admin/redecode` gets wrong: an outlet-led card (redecode
 * never rewrites `outlets_json`) and a repair that doesn't change the rendering (redecode persists
 * nothing when the hash matches). Plus the invariant that a data repair must not look like activity.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { renderStoryCard } from "@/lib/redecode";

const KEY = "test-replay-key";
const CH = "C_TEST";
const NOW = 1788000000000;

interface Update {
  channel?: string;
  ts?: string;
  attachments?: { text?: string }[];
}

async function call(qs = "", auth: string | null = KEY) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://feed.test/admin/repair-snippets${qs}`, {
      method: "POST",
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    }),
    { ...env, REPLAY_KEY: KEY, POSTING_ENABLED: "true" },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Insert a story. `outlets` defaults to a single outlet mirroring the primary. */
async function seed(o: {
  key: string;
  ts: string;
  snippet: string | null;
  outlets?: Outlet[];
  renderHash?: string | null;
  updatedAt?: number;
}) {
  const primary = {
    url: "https://example.test/a",
    outletUrl: null,
    title: "A headline",
    sourceName: "The Age",
    mediaType: "online_news",
    countryCode: "AU",
    reach: 1000,
    sentiment: null,
    publishedAt: null,
    snippet: o.snippet,
    author: null,
    briefName: "MPs",
    imageUrl: null,
    matchedKeywords: [],
    raw: null,
  };
  const outlets = o.outlets ?? [{ name: "The Age", url: "https://example.test/a", reach: 1000, snippet: o.snippet }];
  await env.DB.prepare(
    `INSERT INTO stories (story_key, slack_ts, channel, brief_label, primary_mention_json, outlets_json,
       brief_labels_json, simhash, media_type, render_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'MPs', ?, ?, '["MPs"]', NULL, 'online_news', ?, ?, ?)`,
  )
    .bind(
      o.key,
      o.ts,
      CH,
      JSON.stringify(primary),
      JSON.stringify(outlets),
      o.renderHash ?? "stale-hash",
      NOW,
      o.updatedAt ?? NOW,
    )
    .run();
}

interface Outlet {
  name: string;
  url: string | null;
  reach: number | null;
  snippet?: string | null;
}

async function storyRow(key: string) {
  return await env.DB.prepare(
    "SELECT primary_mention_json, outlets_json, updated_at, render_hash FROM stories WHERE story_key = ?",
  )
    .bind(key)
    .first<{ primary_mention_json: string; outlets_json: string; updated_at: number; render_hash: string }>();
}

describe("POST /admin/repair-snippets", () => {
  let updates: Update[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM stories").run();
    updates = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("chat.update")) {
          updates.push(JSON.parse(String(init?.body ?? "{}")) as Update);
          return Response.json({ ok: true, ts: "1.1" });
        }
        return Response.json({ ok: true, ts: "1.1" });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("repairs an outlet's snippet — the gap /admin/redecode can never close", async () => {
    // A high-reach outlet leads the card with ITS snippet, and redecode only ever rewrites
    // primary_mention_json, so this text survives any number of redecodes.
    await seed({
      key: "k1",
      ts: "1.1",
      snippet: "A clean primary snippet.",
      outlets: [
        { name: "The Age", url: "https://example.test/a", reach: 1000, snippet: "A clean primary snippet." },
        { name: "Herald Sun", url: "https://example.test/b", reach: 900_000, snippet: ", Mums for Nuclear said." },
      ],
    });
    const body = (await (await call()).json()) as { needRepair: number; repaired: number };
    expect(body.needRepair).toBe(1);
    expect(body.repaired).toBe(1);

    const outlets = JSON.parse((await storyRow("k1"))!.outlets_json) as Outlet[];
    expect(outlets[1]!.snippet).toBe("…Mums for Nuclear said.");
    expect(outlets[0]!.snippet).toBe("A clean primary snippet."); // untouched
  });

  it("persists a data-only repair without touching Slack when the card doesn't change", async () => {
    // Redecode skips these entirely, leaving the stale text to resurface on a later re-render.
    // Seed render_hash with the hash of the ALREADY-TIDIED render, so the repair provably produces
    // an identical card and we exercise the data-only branch rather than assuming it.
    await seed({ key: "k2", ts: "2.2", snippet: ". The premier said today." });
    const seeded = (await env.DB.prepare("SELECT * FROM stories WHERE story_key = 'k2'").first()) as never;
    const tidiedPrimary = { ...JSON.parse((seeded as { primary_mention_json: string }).primary_mention_json), snippet: "The premier said today." };
    const tidiedOutlets = [{ name: "The Age", url: "https://example.test/a", reach: 1000, snippet: "The premier said today." }];
    const { hash } = renderStoryCard(seeded, tidiedPrimary, tidiedOutlets);
    await env.DB.prepare("UPDATE stories SET render_hash = ? WHERE story_key = 'k2'").bind(hash).run();

    const body = (await (await call()).json()) as { needRepair: number; cardChanged: number; repaired: number };
    expect(body.needRepair).toBe(1);
    expect(body.cardChanged).toBe(0); // identical render — nothing to send
    expect(body.repaired).toBe(1); // ...but the stored text IS fixed
    expect(updates).toEqual([]);
    const primary = JSON.parse((await storyRow("k2"))!.primary_mention_json) as { snippet: string };
    expect(primary.snippet).toBe("The premier said today.");
  });

  it("never bumps updated_at — a repair must not revive a settled story as a merge target", async () => {
    // updated_at drives the 72h syndication window; bumping it here would make a months-old story
    // eligible to absorb a new article.
    await seed({ key: "k3", ts: "3.3", snippet: ", mid-clause text", updatedAt: NOW - 60 * 86400 * 1000 });
    await call();
    expect((await storyRow("k3"))!.updated_at).toBe(NOW - 60 * 86400 * 1000);
  });

  it("normalizes Meltwater's own `...` marker, and skips rows already in canonical form", async () => {
    await seed({ key: "k4", ts: "4.4", snippet: "...their truncation marker" });
    await seed({ key: "k5", ts: "5.5", snippet: "\u2026an already-cleansed snippet\u2026" });
    const body = (await (await call()).json()) as { scanned: number; needRepair: number };
    expect(body.scanned).toBe(2);
    expect(body.needRepair).toBe(1); // only k4 — k5 is a no-op, so the sweep is idempotent
    const primary = JSON.parse((await storyRow("k4"))!.primary_mention_json) as { snippet: string };
    expect(primary.snippet).toBe("\u2026their truncation marker\u2026");
  });

  it("dryRun=1 reports the work without writing or calling Slack", async () => {
    await seed({ key: "k6", ts: "6.6", snippet: ". The premier said today." });
    const body = (await (await call("?dryRun=1")).json()) as { needRepair: number; repaired: number };
    expect(body.needRepair).toBe(1);
    expect(body.repaired).toBe(0);
    expect(updates).toEqual([]);
    const primary = JSON.parse((await storyRow("k6"))!.primary_mention_json) as { snippet: string };
    expect(primary.snippet).toBe(". The premier said today."); // untouched
  });

  it("leaves the row untouched when Slack rejects the update, so a re-run retries it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("chat.update")
          ? Response.json({ ok: false, error: "message_not_found" })
          : Response.json({ ok: true }),
      ),
    );
    // `seed` leaves render_hash deliberately stale, so the card provably changes and an update is
    // always attempted — no conditional assertion that could pass by never running.
    await seed({ key: "k7", ts: "7.7", snippet: ". The premier said today." });
    const body = (await (await call()).json()) as { failed: number; repaired: number; cardChanged: number };
    expect(body.cardChanged).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.repaired).toBe(0);
    const primary = JSON.parse((await storyRow("k7"))!.primary_mention_json) as { snippet: string };
    expect(primary.snippet).toBe(". The premier said today."); // not persisted ahead of Slack
  });

  it("requires the REPLAY_KEY bearer", async () => {
    expect((await call("", "wrong")).status).toBe(403);
    expect((await call("", null)).status).toBe(403);
  });
});
