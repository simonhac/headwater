import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { reparseStory, renderStoryCard, resolveBroadcast, redecodeRecentStories } from "@/lib/redecode";
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

const radioDoc = {
  providerType: "tveyes_radio",
  statusLine: "🔊 1.1M Reach",
  source: "MPs",
  authorName: "Ben Davis",
  links: { source: trackingUrl("https://transition.meltwater.com/paywall/redirect/xyz") },
};

describe("reparseStory + renderStoryCard (redecode.ts)", () => {
  it("re-decodes a stale byline header (Jorge Branco → 9News), moving the reporter to Author", () => {
    // The stored snapshot has the pre-fix decoding: the byline sat in the header, no Author.
    const row = storyRow(nineDoc, { sourceName: "Jorge Branco", author: null });
    const { oldPrimary, reparsed } = reparseStory(row);
    expect(oldPrimary.sourceName).toBe("Jorge Branco"); // the "from"
    expect(reparsed!.sourceName).toBe("9News"); // the "to"
    expect(reparsed!.author).toBe("Jorge Branco");
    const { hash } = renderStoryCard(row, reparsed!);
    expect(row.render_hash === hash).toBe(false); // NULL render_hash → changed on the first backfill
  });

  it("is idempotent once render_hash matches the current render", () => {
    const row = storyRow(nineDoc); // snapshot already reflects current decoding
    const { hash } = renderStoryCard(row, reparseStory(row).reparsed!);
    const row2 = { ...row, render_hash: hash };
    const { hash: hash2 } = renderStoryCard(row2, reparseStory(row2).reparsed!);
    expect(row2.render_hash === hash2).toBe(true); // hash matches → nothing to update
  });

  it("flags a format-only change via render_hash even when the parse is unchanged (also-mentions)", () => {
    const doc = {
      providerType: "news",
      statusLine: "😐 4.82k Reach",
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
    const row = storyRow(doc, {}, "stalehash");
    const { attachment, hash } = renderStoryCard(row, reparseStory(row).reparsed!);
    expect(row.render_hash === hash).toBe(false); // stale hash → changed
    expect(attachment.text).toContain("(also mentions `Andrew Wilkie` `Allegra Spender` `MP`)");
  });

  it("returns reparsed=null when the snapshot has no re-parseable raw payload", () => {
    const row = storyRow(nineDoc);
    const primary = JSON.parse(row.primary_mention_json) as Record<string, unknown>;
    delete primary.raw; // no embedded webhook doc → nothing to re-parse
    row.primary_mention_json = JSON.stringify(primary);
    expect(reparseStory(row).reparsed).toBeNull();
  });
});

describe("resolveBroadcast (redecode.ts)", () => {
  it("upgrades to the resolved station, dropping the reporter to the byline", () => {
    const { oldPrimary, reparsed } = reparseStory(storyRow(radioDoc, { sourceName: "Ben Davis", author: null }));
    // A pure re-parse of a radio item falls back to the reporter (no domain); a resolved station wins.
    expect(reparsed!.sourceName).toBe("Ben Davis");
    const up = resolveBroadcast(reparsed!, oldPrimary, "702 ABC Sydney");
    expect(up.sourceName).toBe("702 ABC Sydney");
    expect(up.author).toBe("Ben Davis"); // reporter demoted to byline
  });

  it("preserves the stored station header when no station resolves (no regression to reporter)", () => {
    const { oldPrimary, reparsed } = reparseStory(storyRow(radioDoc, { sourceName: "4BC 1116 News Talk", author: "Ben Davis" }));
    const kept = resolveBroadcast(reparsed!, oldPrimary, null);
    expect(kept.sourceName).toBe("4BC 1116 News Talk");
    expect(kept.author).toBe("Ben Davis");
  });

  it("keeps a station-like authorName header when no station resolves (authorName-trust)", () => {
    const stationDoc = { ...radioDoc, authorName: "666 ABC Canberra" };
    const { oldPrimary, reparsed } = reparseStory(storyRow(stationDoc));
    expect(reparsed!.sourceName).toBe("666 ABC Canberra"); // parse keeps the station-like authorName
    const out = resolveBroadcast(reparsed!, oldPrimary, null);
    expect(out.sourceName).toBe("666 ABC Canberra"); // trusted as the outlet, no safety net
    expect(out.author).toBeNull();
  });

  it("applies the safety net when a presenter header has no resolved station (never a person as outlet)", () => {
    // oldPrimary is itself the presenter (the stuck-bug snapshot) → neutral masthead + presenter byline.
    const { oldPrimary, reparsed } = reparseStory(storyRow(radioDoc, { sourceName: "Ben Davis", author: null }));
    const out = resolveBroadcast(reparsed!, oldPrimary, null);
    expect(out.sourceName).toBe("Radio");
    expect(out.author).toBe("Ben Davis");
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
