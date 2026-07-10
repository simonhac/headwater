import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { redecodeStory, redecodeRecentStories } from "@/lib/redecode";
import type { StoryRow } from "@/lib/story";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { Env } from "@/env";

// Meltwater tracking redirects double-encode the real url under `?u=`; mirror parse.test.ts's helper.
function trackingUrl(target: string): string {
  return `https://t.fake-notify.example/v2/click?m=webhook&u=${encodeURIComponent(encodeURIComponent(target))}`;
}

// Build a stored story row from a raw webhook doc. `stale` overrides the headlined-mention snapshot to
// simulate a card posted under OLDER decoding; `renderHash` is the hash of the card last sent to Slack.
function storyRow(
  raw: Record<string, unknown>,
  stale: Partial<NormalizedMention> = {},
  renderHash: string | null = null,
): StoryRow {
  const primary = { ...parseWebhookPayload(raw)[0]!, ...stale };
  const outlets = [{ name: primary.sourceName ?? "Unknown source", url: primary.url, reach: primary.reach }];
  return {
    story_key: "k1",
    slack_ts: "1783674582.313699",
    channel: "C123",
    brief_label: "MPs",
    primary_mention_json: JSON.stringify(primary),
    outlets_json: JSON.stringify(outlets),
    brief_labels_json: JSON.stringify(["MPs"]),
    simhash: null,
    media_type: primary.mediaType,
    render_hash: renderHash,
    created_at: 1_783_674_582_000,
    updated_at: 1_783_674_582_000,
  };
}

const nineDoc = {
  providerType: "news",
  statusLine: "😐 8M Reach — 😐 Neutral Sentiment",
  source: "MPs",
  authorName: "Jorge Branco",
  links: {
    source: trackingUrl("https://www.nine.com.au/"),
    article: trackingUrl("https://transition.meltwater.com/paywall/redirect/abc?productType=alerts"),
  },
};

describe("redecodeStory (redecode.ts)", () => {
  it("re-decodes a stale byline header (Jorge Branco → 9News), moving the reporter to Author", () => {
    // The stored snapshot has the pre-fix decoding: the byline sat in the header, no Author.
    const r = redecodeStory(storyRow(nineDoc, { sourceName: "Jorge Branco", author: null }));
    expect(r.skipped).toBe(false);
    expect(r.changed).toBe(true); // NULL render_hash → treated as changed on the first backfill
    expect(r.from).toBe("Jorge Branco");
    expect(r.to).toBe("9News");
    expect(r.newPrimary.author).toBe("Jorge Branco");
  });

  it("is idempotent once render_hash matches the current render", () => {
    const row = storyRow(nineDoc); // snapshot already reflects current decoding
    const first = redecodeStory(row);
    const second = redecodeStory({ ...row, render_hash: first.hash });
    expect(second.changed).toBe(false); // hash matches → nothing to update
  });

  it("flags a format-only change via render_hash even when the parse is unchanged (also-mentions)", () => {
    // Same parse either way; only buildAttachment's output differs from what was last sent. A stale
    // hash still marks the card as changed — a snapshot-vs-snapshot diff would have missed this.
    const doc = {
      providerType: "news",
      statusLine: "😐 4.82k Reach — 😐 Neutral Sentiment",
      source: "MPs",
      title: "5th National Whistleblowing Symposium",
      authorName: "Transparency International Australia",
      keywords: "Andrew Wilkie, Allegra Spender, MP",
      text: "...Speakers include: Assistant Treasurer Dr Daniel Mulino and Senator Paul Scarr Andrew...",
      links: {
        source: trackingUrl("https://transparency.org.au/"),
        article: trackingUrl("https://t.notifications.meltwater.com/v2/xyz"),
      },
    };
    const r = redecodeStory(storyRow(doc, {}, "stalehash"));
    expect(r.skipped).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.attachment.text).toContain("(also mentions `Andrew Wilkie` `Allegra Spender` `MP`)");
  });

  it("preserves a broadcast station header instead of regressing to the reporter byline", () => {
    // Radio: links.source is only a Meltwater host, so a pure re-parse falls back to the reporter
    // (authorName). The station name was resolved live in process.ts and stored — keep it.
    const radioDoc = {
      providerType: "tveyes_radio",
      statusLine: "🔊 1.1M Reach",
      source: "MPs",
      authorName: "Ben Davis",
      links: { source: trackingUrl("https://transition.meltwater.com/paywall/redirect/xyz") },
    };
    const r = redecodeStory(storyRow(radioDoc, { sourceName: "4BC 1116 News Talk", author: "Ben Davis" }));
    expect(r.to).toBe("4BC 1116 News Talk"); // NOT "Ben Davis"
    expect(r.newPrimary.sourceName).toBe("4BC 1116 News Talk");
    expect(r.newPrimary.author).toBe("Ben Davis");
  });

  it("skips a story whose snapshot has no re-parseable raw payload", () => {
    const row = storyRow(nineDoc);
    const primary = JSON.parse(row.primary_mention_json) as Record<string, unknown>;
    delete primary.raw; // no embedded webhook doc → nothing to re-parse
    row.primary_mention_json = JSON.stringify(primary);
    const r = redecodeStory(row);
    expect(r.skipped).toBe(true);
    expect(r.changed).toBe(false);
  });
});

// A D1Database stub: updatedSince() reads `.all()`, updateRenderState() calls `.run()`.
function fakeDB(rows: StoryRow[]) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
        run: async () => ({}),
        first: async () => null,
      }),
    }),
  };
}

describe("redecodeRecentStories — per-call cap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps chat.update calls per invocation and reports the remainder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: "1.2" }) })),
    );
    const rows = Array.from({ length: 45 }, (_, i) => ({
      ...storyRow(nineDoc, { sourceName: "Jorge Branco", author: null }, "stale"),
      story_key: "k" + i,
      slack_ts: "17." + i,
    }));
    const env = { DB: fakeDB(rows), SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;
    const res = await redecodeRecentStories(env, { hours: 168, dryRun: false, now: 1_783_674_582_000 });
    expect(res.changed).toBe(45);
    expect(res.updated).toBe(40); // MAX_UPDATES_PER_CALL
    expect(res.remaining).toBe(5);
    expect(res.failed).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(40);
  });
});
