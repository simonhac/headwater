import { describe, it, expect, vi, afterEach } from "vitest";
import { sweepOrphans } from "@/lib/orphans";
import type { Env } from "@/env";
import type { Routing } from "@/lib/routing";

/** D1 stub: sweepOrphans runs `SELECT channel, slack_ts FROM stories`.all() plus loadRouting's
 * `SELECT value FROM ops_state WHERE key = ?`.first(). */
function fakeDB(stories: { channel: string; slack_ts: string }[], routing?: Partial<Routing>) {
  return {
    prepare: (sql: string) => ({
      all: async () => ({ results: stories }),
      bind: () => ({
        first: async () =>
          sql.includes("ops_state") && routing
            ? { value: JSON.stringify({ v: 1, briefs: {}, updatedAt: 0, ...routing }) }
            : null,
      }),
    }),
  };
}
const resp = (body: unknown) => ({ status: 200, json: async () => body });
const history = (messages: unknown[]) => resp({ ok: true, messages, response_metadata: { next_cursor: "" } });

describe("sweepOrphans", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes bot cards with no backing story; keeps backed cards, text posts, and human messages", async () => {
    const msgs = [
      { ts: "1", bot_id: "B", attachments: [{ author_name: "9 Brisbane", title: "x" }] }, // backed by a story
      { ts: "2", bot_id: "B", attachments: [{ author_name: "TV" }] }, // orphan card
      { ts: "3", bot_id: "B" }, // heartbeat/text post (no attachment) — skip
      { ts: "4", user: "U", attachments: [{ author_name: "someone" }] }, // human — skip
    ];
    const deletes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("conversations.history")) return history(msgs);
        deletes.push(JSON.parse(String(init!.body)).ts); // chat.delete
        return resp({ ok: true });
      }),
    );
    const env = {
      DB: fakeDB([{ channel: "C1", slack_ts: "1" }]),
      SLACK_BOT_TOKEN: "xoxb",
      SLACK_DEFAULT_CHANNEL: "C1",
    } as unknown as Env;

    const res = await sweepOrphans(env, { dryRun: false });
    expect(res.channels).toEqual(["C1"]);
    expect(res.scanned).toBe(2); // 2 bot cards
    expect(res.orphans).toBe(1); // ts "2"
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
    expect(deletes).toEqual(["2"]); // only the orphan was deleted
  });

  it("dryRun reports orphans without deleting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => history([{ ts: "2", bot_id: "B", attachments: [{ author_name: "TV" }] }])),
    );
    const env = { DB: fakeDB([]), SLACK_BOT_TOKEN: "xoxb", SLACK_DEFAULT_CHANNEL: "C1" } as unknown as Env;

    const res = await sweepOrphans(env, { dryRun: true });
    expect(res.orphans).toBe(1);
    expect(res.deleted).toBe(0);
    expect(res.samples[0]!.label).toContain("TV");
  });

  it("scans every routed channel, and the allow-list is channel-qualified", async () => {
    // Both channels carry a card at ts "1". Only C1 has a story for it, so C2's is an orphan —
    // a bare-ts allow-list would have spared it.
    const card = { ts: "1", bot_id: "B", attachments: [{ author_name: "ABC" }] };
    const scanned: string[] = [];
    const deletes: { channel: string; ts: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("conversations.history")) {
          scanned.push(new URL(u).searchParams.get("channel")!);
          return history([card]);
        }
        deletes.push(JSON.parse(String(init!.body)));
        return resp({ ok: true });
      }),
    );
    const env = {
      DB: fakeDB([{ channel: "C1", slack_ts: "1" }], { briefs: { "vic-election-2026": ["C1", "C2"] } }),
      SLACK_BOT_TOKEN: "xoxb",
      SLACK_DEFAULT_CHANNEL: "C1",
    } as unknown as Env;

    const res = await sweepOrphans(env, { dryRun: false });
    expect(res.channels).toEqual(["C1", "C2"]);
    expect(scanned).toEqual(["C1", "C2"]);
    expect(res.scanned).toBe(2); // one card per channel
    expect(res.orphans).toBe(1);
    expect(deletes).toEqual([{ channel: "C2", ts: "1" }]);
  });
});
