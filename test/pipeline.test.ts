import { describe, it, expect } from "vitest";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters } from "@/lib/filter/engine";
import { highlightKeywordsAsCode, buildMentionsLine, truncate, escapeMrkdwn } from "@/lib/slack/highlight";
import { buildBlocks } from "@/lib/slack/format";
import { normalizeTitle, storyKey, addOutlet, type Outlet } from "@/lib/story";
import type { FeedConfig } from "@/config/feed.config";

const cfg: FeedConfig = {
  minSourceReach: 100000,
  includeMediaTypes: ["news"],
  excludeMediaTypes: ["radio"],
  sourceAllowlist: null,
  sourceBlocklist: [],
  allowedCountryCodes: ["AU"],
  requireMatchedKeyword: false,
  defaultBriefLabel: "Media",
  briefs: [{ id: "kp", label: "Key People", matchNames: ["key people"], keywords: ["renewable", "Ross Garnaut"] }],
};

const payload = {
  search_name: "Key People",
  documents: [
    {
      document_url: "https://x.example/a",
      document_title: "Big renewable news",
      source_name: "The Australian",
      source_information_type: "news",
      source_country_code: "AU",
      source_reach: 480000,
      document_opening_text: "The renewable rollout and Ross Garnaut. renewable again.",
      document_author: "Judith Sloan",
      document_matched_keywords: ["renewable", "Ross Garnaut"],
    },
    {
      document_url: "https://x.example/b",
      document_title: "Radio wrap",
      source_name: "Radio Geelong",
      source_information_type: "radio",
      source_country_code: "AU",
      source_reach: 5000,
    },
  ],
};

describe("parse", () => {
  it("extracts fields and inherits top-level brief name", () => {
    const m = parseWebhookPayload(payload);
    expect(m).toHaveLength(2);
    expect(m[0]!.sourceName).toBe("The Australian");
    expect(m[0]!.reach).toBe(480000);
    expect(m[0]!.briefName).toBe("Key People");
    expect(m[0]!.matchedKeywords).toContain("Ross Garnaut");
  });
});

describe("filter", () => {
  it("keeps the news item and drops the radio item", () => {
    const { kept, dropped } = applyFilters(parseWebhookPayload(payload), cfg);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.mention.sourceName).toBe("The Australian");
    expect(kept[0]!.brief.label).toBe("Key People");
    expect(dropped[0]!.reason).toMatch(/media_type_excluded/);
  });

  it("drops below minSourceReach when reach is present", () => {
    const c2 = { ...cfg, excludeMediaTypes: [], includeMediaTypes: null };
    const dropped = applyFilters(parseWebhookPayload(payload), c2).dropped;
    expect(dropped.some((d) => /reach_below_min/.test(d.reason))).toBe(true);
  });
});

describe("highlight", () => {
  it("wraps keywords as code pills, longest-first, no double-wrap", () => {
    const out = highlightKeywordsAsCode("Ross Garnaut backs renewable energy", ["renewable", "Ross Garnaut", "Ross"]);
    expect(out).toBe("`Ross Garnaut` backs `renewable` energy");
  });
  it("builds a Mentions line with counts", () => {
    const line = buildMentionsLine("renewable renewable Ross Garnaut renewable", ["renewable", "Ross Garnaut"]);
    expect(line).toBe("Mentions: `renewable (3)`, `Ross Garnaut (1)`");
  });
  it("escapes mrkdwn and truncates on a word boundary", () => {
    expect(escapeMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    const long = Array.from({ length: 100 }, () => "alpha").join(" ");
    const t = truncate(long, 50);
    expect(t.length).toBeLessThanOrEqual(51);
    expect(t.endsWith("alpha…")).toBe(true); // snapped to a whole word
  });
});

describe("format", () => {
  it("produces the Streem block structure with unfurl-free headline + brief footer", () => {
    const { kept } = applyFilters(parseWebhookPayload(payload), cfg);
    const blocks = buildBlocks(kept[0]!.mention, kept[0]!.brief) as any[];
    expect(blocks[0].type).toBe("context");
    expect(blocks[1].text.text).toContain("<https://x.example/a|");
    expect(blocks[1].text.text).toContain("*"); // bold headline
    expect(JSON.stringify(blocks)).toContain("Organisation Brief");
    expect(JSON.stringify(blocks)).toContain("Key People");
  });

  it("appends an 'Also in' line when other outlets are supplied", () => {
    const { kept } = applyFilters(parseWebhookPayload(payload), cfg);
    const blocks = buildBlocks(kept[0]!.mention, kept[0]!.brief, ["The Age", "SMH"]) as any[];
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("context");
    expect(last.elements[0].text).toContain("Also in: The Age  ·  SMH");
  });
});

describe("syndication", () => {
  it("normalizes titles so verbatim republications share a key", async () => {
    expect(normalizeTitle("Zero chance: Nats & Libs!")).toBe("zero chance nats libs");
    const a = await storyKey("Zero chance: Nats & Libs!");
    const b = await storyKey("zero chance   nats  libs");
    expect(a).toBe(b);
  });

  it("addOutlet de-dupes by url or name", () => {
    let outlets: Outlet[] = [{ name: "The Australian", url: "https://a", reach: 1 }];
    outlets = addOutlet(outlets, { name: "The Age", url: "https://b", reach: 2 });
    outlets = addOutlet(outlets, { name: "the australian", url: "https://c", reach: 3 }); // same name
    outlets = addOutlet(outlets, { name: "SMH", url: "https://a", reach: 4 }); // same url
    expect(outlets.map((o) => o.name)).toEqual(["The Australian", "The Age"]);
  });
});
