import { describe, it, expect } from "vitest";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters } from "@/lib/filter/engine";
import { highlightKeywordsAsCode, buildMentionsLine, truncate, escapeMrkdwn } from "@/lib/slack/highlight";
import { buildAttachment, buildPostPayload, briefColor, fmtFriendly, fmtReach, cleanTitle } from "@/lib/slack/format";
import { sourceLogoUrl, faviconUrl, mediaTypeEmoji } from "@/lib/slack/icons";
import { normalizeTitle, storyKey, addOutlet, addBriefLabel, type Outlet } from "@/lib/story";
import { simhash64, hammingDistance, tokenize, shingles } from "@/lib/simhash";
import { DEFAULT_BRIEF_COLOR, type FeedConfig } from "@/config/feed.config";

const cfg: FeedConfig = {
  minSourceReach: 100000,
  includeMediaTypes: ["news"],
  excludeMediaTypes: ["radio"],
  sourceAllowlist: null,
  sourceBlocklist: [],
  allowedCountryCodes: ["AU"],
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

  // Sanitized shape of a real Meltwater "Every Mention" webhook (fake tokens, trimmed text).
  const everyMention = {
    id: "abc123",
    type: "Every Mention",
    providerType: "tveyes_radio",
    title: "Some Program - Wed, 08 Jul 2026 08:04:25 +1000",
    statusLine: "🔊 55.9k Reach — 😐 Neutral Sentiment",
    source: "MPs",
    keywords: "MP, Kate Chaney",
    authorName: "Jim O'Rourke",
    image: "https://example.test/img.jpg",
    text: "Independent MP Kate Chaney is calling on the government.",
    links: {
      article: "https://t.notifications.example/v2/x?m=webhook&u=https%253A%252F%252Fwww.heraldsun.com.au%252Fa",
      source: "https://t.notifications.example/v2/x?m=webhook&u=https%253A%252F%252Fwww.heraldsun.com.au%252F",
    },
  };

  it("maps the 'Every Mention' shape: masthead from domain, byline, medium, reach", () => {
    const [m] = parseWebhookPayload(everyMention);
    expect(m!.sourceName).toBe("Herald Sun"); // masthead from heraldsun.com.au (authorName is a byline)
    expect(m!.author).toBe("Jim O'Rourke"); // byline moved to Author
    expect(m!.mediaType).toBe("radio"); // tveyes_radio → radio
    expect(m!.reach).toBe(55900); // parsed from statusLine
    expect(m!.sentiment).toBe("neutral");
    expect(m!.briefName).toBe("MPs"); // `source` = brief
    expect(m!.matchedKeywords).toEqual(["MP", "Kate Chaney"]);
    expect(m!.url).toContain("t.notifications.example"); // licensed/tracking link kept
    expect(m!.outletUrl).toBe("https://www.heraldsun.com.au/");
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
  it("builds a classic attachment: logo+masthead, headline link, Author|Brief fields", () => {
    const { kept } = applyFilters(parseWebhookPayload(payload), cfg);
    const a = buildAttachment(kept[0]!.mention, kept[0]!.brief);
    expect(a.author_name).toBe("The Australian"); // masthead
    expect(a.author_icon).toBeTruthy(); // logo favicon
    expect(a.title).toBe("Big renewable news");
    expect(a.title_link).toBe("https://x.example/a");
    expect(a.fields?.some((f) => f.title === "Author" && f.value === "Judith Sloan")).toBe(true);
    expect(a.fields?.some((f) => f.title === "Organisation Brief" && f.value === "Key People")).toBe(true);
    expect(a.mrkdwn_in).toContain("text");
  });

  it("builds a payload with no top-level text and a brief-coloured attachment", () => {
    const { kept } = applyFilters(parseWebhookPayload(payload), cfg);
    const coloured = { ...kept[0]!.brief, color: "#123456" };
    const p = buildPostPayload(kept[0]!.mention, coloured, "C123") as any;
    expect(p.channel).toBe("C123");
    expect(p.text).toBeUndefined(); // no plain line above the card
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].color).toBe("#123456");
    expect(p.attachments[0].fallback).toContain("The Australian");
  });

  it("lists the outlets with reach and appends 'also matched' to the footer", () => {
    const { kept } = applyFilters(parseWebhookPayload(payload), cfg);
    const others = [
      { name: "The Age", url: "https://age.example/b", reach: null },
      { name: "SMH", url: "https://smh.example/c", reach: null },
    ];
    const a = buildAttachment(kept[0]!.mention, kept[0]!.brief, others, ["MPs", "Teals"]);
    expect(a.footer).toMatch(/3 outlets/); // masthead + the two others
    expect(a.footer).toContain("The Age · SMH"); // null-reach outlets: bare names, last
    expect(a.footer).toContain("also matched MPs, Teals");
  });
});

describe("near-duplicate (SimHash)", () => {
  const A =
    "unable to make calls or use data on their mobile phones or other devices. Telstra says they are investigating the issue. Federal independent MP Andrew Wilkie has slammed the state government after they approved a new gambling license to online bookmaker better. Mr Wilkie saying the movie is rolling";
  const B =
    "unable to make calls or use data on their mobile phones or other devices. Telstra says they are investigating the issue. Federal Independent MP Andrew Wilkie. has slammed the state government after they approved a new gambling license to online bookmaker Better, Mr Wilkie saying the movie is rolling";
  const C =
    "The Prime Minister today announced a new renewable energy target as part of the government climate policy agenda for the coming decade ahead of the next election";

  it("gives the same segment a tiny distance and different segments a large one", () => {
    const a = simhash64(A)!;
    const b = simhash64(B)!;
    const c = simhash64(C)!;
    expect(hammingDistance(a, a)).toBe(0);
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(3); // same clip, different ASR → merges
    expect(hammingDistance(a, c)).toBeGreaterThan(10); // unrelated → never merges
  });

  it("returns null for empty/too-short text", () => {
    expect(simhash64(null)).toBeNull();
    expect(simhash64("two words")).toBeNull();
  });

  it("tokenizes and shingles", () => {
    expect(tokenize("Hello, World! 42")).toEqual(["hello", "world", "42"]);
    expect(shingles(["a", "b", "c", "d"], 3)).toEqual(["a b c", "b c d"]);
    expect(shingles(["a", "b"], 3)).toEqual(["a", "b"]); // shorter than w → raw tokens
  });

  it("addBriefLabel de-dupes case-insensitively, primary first", () => {
    expect(addBriefLabel(["Climate 200"], "MPs")).toEqual(["Climate 200", "MPs"]);
    expect(addBriefLabel(["Climate 200", "MPs"], "climate 200")).toEqual(["Climate 200", "MPs"]);
  });
});

describe("date & reach formatting", () => {
  it("uses the timestamp's own offset for the abbreviation", () => {
    expect(fmtFriendly("2026-07-08T08:30:58+10:00")).toBe("Wed, 8 Jul 2026, 8:30am AEST");
    expect(fmtFriendly("2026-01-15T14:05:00+11:00")).toBe("Thu, 15 Jan 2026, 2:05pm AEDT");
    expect(fmtFriendly("2026-07-08T09:00:00+08:00")).toBe("Wed, 8 Jul 2026, 9:00am AWST");
    expect(fmtFriendly("2026-07-08T09:00:00+09:30")).toBe("Wed, 8 Jul 2026, 9:00am ACST");
    expect(fmtFriendly(null)).toBeNull();
    expect(fmtFriendly("not a date")).toBeNull();
  });

  it("formats reach compactly", () => {
    expect(fmtReach(480000)).toBe("480K reach");
    expect(fmtReach(5860)).toBe("5.9K reach");
    expect(fmtReach(1_200_000)).toBe("1.2M reach");
    expect(fmtReach(0)).toBeNull();
    expect(fmtReach(null)).toBeNull();
  });

  it("strips a broadcast title's air-time (it moves to the footer) but leaves headlines alone", () => {
    expect(cleanTitle("Patty and Ravyn - Wed, 08 Jul 2026 08:30:58 +1000")).toBe("Patty and Ravyn");
    expect(cleanTitle("Zero chance Nats and Libs can support opposing policies")).toBe(
      "Zero chance Nats and Libs can support opposing policies",
    );
    expect(cleanTitle(null)).toBeNull();
  });
});

describe("icons", () => {
  it("resolves per-outlet logos: curated first, then the article domain", () => {
    expect(sourceLogoUrl("The Australian", null)).toContain("theaustralian.com.au");
    expect(sourceLogoUrl("ABC Esperance", null)).toContain("abc.net.au");
    expect(sourceLogoUrl("Random Blog", "https://www.randomblog.example/a")).toContain("randomblog.example");
    expect(sourceLogoUrl(null, null)).toBeNull();
  });

  it("derives favicons from a URL domain, safely", () => {
    expect(faviconUrl("https://www.example.com/path")).toBe("https://www.google.com/s2/favicons?sz=64&domain=example.com");
    expect(faviconUrl("not a url")).toBeNull();
    expect(faviconUrl(null)).toBeNull();
  });

  it("maps media types to emoji (online before news)", () => {
    expect(mediaTypeEmoji("radio")).toBe("📻");
    expect(mediaTypeEmoji("online_news")).toBe("🌐");
    expect(mediaTypeEmoji("news")).toBe("📰");
    expect(mediaTypeEmoji(null)).toBe("📰");
  });

  it("briefColor falls back to the default", () => {
    expect(briefColor({ id: "x", label: "X", keywords: [], color: "#abcdef" })).toBe("#abcdef");
    expect(briefColor({ id: "x", label: "X", keywords: [] })).toBe(DEFAULT_BRIEF_COLOR);
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
