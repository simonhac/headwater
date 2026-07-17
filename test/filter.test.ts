import { describe, it, expect } from "vitest";
import { applyFilters, resolveBrief, keywordsFor } from "@/lib/filter/engine";
import type { FeedConfig, BriefRule } from "@/config/feed.config";
import type { NormalizedMention } from "@/lib/meltwater/types";

// --- Fixtures ---------------------------------------------------------------

function mention(overrides: Partial<NormalizedMention> = {}): NormalizedMention {
  return {
    url: "https://example.test/a",
    outletUrl: null,
    title: "A headline",
    sourceName: "The Australian",
    mediaType: "news",
    countryCode: "AU",
    reach: 500000,
    sentiment: "neutral",
    publishedAt: "2026-07-08T08:30:00+10:00",
    snippet: "Some opening text about the story.",
    author: "A. Byline",
    briefName: "MPs",
    imageUrl: null,
    matchedKeywords: [],
    raw: {},
    ...overrides,
  };
}

const briefMps: BriefRule = { id: "mps", label: "MPs", matchNames: ["mps"], keywords: ["MP", "Wilkie"] };
const briefTeals: BriefRule = { id: "teals", label: "Teals", matchNames: ["teals"], keywords: ["teal"] };

function config(overrides: Partial<FeedConfig> = {}): FeedConfig {
  return {
    minSourceReach: 0,
    includeMediaTypes: null,
    excludeMediaTypes: [],
    sourceAllowlist: null,
    sourceBlocklist: [],
    allowedCountryCodes: null,
    requireMatchedKeyword: false,
    nearDuplicate: {
      enabled: true,
      windowHours: 12,
      maxHammingDistance: 3,
      shingleSize: 3,
      minPhraseOverlap: 0.25,
      minContiguousRun: 12,
      containmentShingleSize: 5,
      maxAirtimeGapHours: 3,
      mediaTypes: ["radio", "tv"],
      crossMediaNetworks: [],
    },
    defaultBriefLabel: "Media Monitoring",
    briefs: [briefMps, briefTeals],
    ...overrides,
  };
}

// --- applyFilters: drop branches -------------------------------------------

describe("applyFilters drop branches", () => {
  it("excludeMediaTypes → media_type_excluded", () => {
    const { kept, dropped } = applyFilters([mention({ mediaType: "radio" })], config({ excludeMediaTypes: ["radio"] }));
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("media_type_excluded");
  });

  it("includeMediaTypes allowlist → media_type_not_included when not on the list", () => {
    const { kept, dropped } = applyFilters([mention({ mediaType: "radio" })], config({ includeMediaTypes: ["news"] }));
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("media_type_not_included");
  });

  it("includeMediaTypes allowlist → keeps a matching media type", () => {
    const { kept, dropped } = applyFilters([mention({ mediaType: "news" })], config({ includeMediaTypes: ["news"] }));
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("allowedCountryCodes → country_excluded", () => {
    const { kept, dropped } = applyFilters([mention({ countryCode: "US" })], config({ allowedCountryCodes: ["AU"] }));
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("country_excluded");
  });

  it("sourceBlocklist → source_blocked", () => {
    const { kept, dropped } = applyFilters(
      [mention({ sourceName: "Sky News" })],
      config({ sourceBlocklist: ["sky"] }),
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("source_blocked");
  });

  it("sourceAllowlist → source_not_allowlisted", () => {
    const { kept, dropped } = applyFilters(
      [mention({ sourceName: "Random Blog" })],
      config({ sourceAllowlist: ["the australian"] }),
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("source_not_allowlisted");
  });

  it("minSourceReach → reach_below_min", () => {
    const { kept, dropped } = applyFilters([mention({ reach: 1000 })], config({ minSourceReach: 100000 }));
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("reach_below_min");
  });

  it("requireMatchedKeyword → no_matched_keyword when nothing matches", () => {
    const { kept, dropped } = applyFilters(
      [mention({ matchedKeywords: [], title: "Weather report", snippet: "Sunny skies", briefName: "Vic State" })],
      config({ requireMatchedKeyword: true, briefs: [] }),
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("no_matched_keyword");
  });

  it("per-brief requireKeyword → brief_keyword_required when the brief's keywords are absent", () => {
    const strictBrief: BriefRule = {
      id: "mps",
      label: "MPs",
      matchNames: ["mps"],
      keywords: ["Wilkie"],
      requireKeyword: true,
    };
    const { kept, dropped } = applyFilters(
      [mention({ matchedKeywords: [], title: "Unrelated headline", snippet: "no match here", briefName: "MPs" })],
      config({ briefs: [strictBrief] }),
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toContain("brief_keyword_required");
  });
});

// --- applyFilters: allow path ----------------------------------------------

describe("applyFilters keep path", () => {
  it("keeps a clean mention and attaches the resolved brief", () => {
    const { kept, dropped } = applyFilters([mention({ briefName: "Teals", title: "A teal wins" })], config());
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.mention.sourceName).toBe("The Australian");
    expect(kept[0]!.brief.label).toBe("Teals");
  });

  it("passes requireMatchedKeyword when a payload keyword is present", () => {
    const { kept } = applyFilters(
      [mention({ matchedKeywords: ["MP"], briefName: "MPs" })],
      config({ requireMatchedKeyword: true }),
    );
    expect(kept).toHaveLength(1);
  });

  it("passes a per-brief requireKeyword when the keyword appears in the text", () => {
    const strictBrief: BriefRule = {
      id: "mps",
      label: "MPs",
      matchNames: ["mps"],
      keywords: ["Wilkie"],
      requireKeyword: true,
    };
    const { kept } = applyFilters(
      [mention({ matchedKeywords: [], title: "Andrew Wilkie speaks", snippet: "...", briefName: "MPs" })],
      config({ briefs: [strictBrief] }),
    );
    expect(kept).toHaveLength(1);
  });
});

// --- resolveBrief ----------------------------------------------------------

describe("resolveBrief", () => {
  it("matches by matchNames (case-insensitive substring of briefName)", () => {
    const b = resolveBrief(mention({ briefName: "Federal TEALS alert" }), config());
    expect(b.id).toBe("teals");
  });

  it("falls back to a keyword match in title/snippet when no name matches", () => {
    const b = resolveBrief(
      mention({ briefName: "Untitled search", title: "About a teal candidate", snippet: "" }),
      config(),
    );
    expect(b.id).toBe("teals");
  });

  it("returns the default brief when nothing matches", () => {
    const b = resolveBrief(
      mention({ briefName: "Nothing here", title: "Weather", snippet: "sunshine" }),
      config({ defaultBriefLabel: "Media Monitoring" }),
    );
    expect(b.id).toBe("default");
    expect(b.label).toBe("Media Monitoring");
  });
});

// --- keywordsFor -----------------------------------------------------------

describe("keywordsFor", () => {
  it("unions payload matchedKeywords with brief keywords, de-duped case-insensitively", () => {
    const kws = keywordsFor(mention({ matchedKeywords: ["mp", "Wilkie"] }), briefMps);
    // "mp"/"MP" and "Wilkie"/"Wilkie" collapse case-insensitively; payload casing wins (seen first).
    const lowered = kws.map((k) => k.toLowerCase());
    expect(lowered).toEqual(["mp", "wilkie"]);
    expect(kws).toContain("mp"); // payload casing kept over brief's "MP"
  });

  it("includes brief-only keywords not present in the payload", () => {
    const kws = keywordsFor(mention({ matchedKeywords: ["renewable"] }), briefMps);
    expect(kws.map((k) => k.toLowerCase())).toEqual(["renewable", "mp", "wilkie"]);
  });
});
