import { describe, it, expect, vi, afterEach } from "vitest";
import { sweepOrphans } from "@/lib/orphans";
import type { Env } from "@/env";

// D1 stub: sweepOrphans only runs `SELECT slack_ts FROM stories`.all() (no bind).
function fakeDB(ts: string[]) {
  return { prepare: () => ({ all: async () => ({ results: ts.map((t) => ({ slack_ts: t })) }) }) };
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
    const env = { DB: fakeDB(["1"]), SLACK_BOT_TOKEN: "xoxb", SLACK_DEFAULT_CHANNEL: "C1" } as unknown as Env;

    const res = await sweepOrphans(env, { dryRun: false });
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
});
