import { describe, it, expect } from "vitest";
import { buildAttachment, buildPostPayload, broadcastMediumLabel } from "@/lib/slack/format";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { BriefRule } from "@/config/feed.config";

// A complete NormalizedMention with sensible defaults; override per-test via `over`.
function mention(over: Partial<NormalizedMention> = {}): NormalizedMention {
  return {
    url: "https://x.example/a",
    outletUrl: null,
    title: "Big renewable news",
    sourceName: "The Australian",
    mediaType: "news",
    countryCode: "AU",
    reach: 480000,
    sentiment: "neutral",
    publishedAt: "2026-07-08T08:30:58+10:00",
    snippet: "The renewable rollout and Ross Garnaut. renewable again.",
    author: "Judith Sloan",
    briefName: "Key People",
    imageUrl: null,
    matchedKeywords: [],
    raw: {},
    ...over,
  };
}

// BriefRule: keywords are highlighted; matchNames/color are optional.
const brief: BriefRule = {
  id: "kp",
  label: "Key People",
  matchNames: ["key people"],
  keywords: ["renewable", "Ross Garnaut"],
};

describe("buildAttachment — author icon / masthead", () => {
  it("sets author_icon from a curated source logo when the source name is known", () => {
    const a = buildAttachment(mention({ url: null, outletUrl: null }), brief);
    // "The Australian" resolves via the curated SOURCE_LOGOS map even with no URL.
    expect(a.author_icon).toContain("theaustralian.com.au");
    expect(a.author_name).toBe("The Australian"); // logo present → no emoji prefix
  });

  it("sets author_icon from the article/outlet domain favicon when the source is unknown", () => {
    const a = buildAttachment(
      mention({ sourceName: "Random Blog", url: "https://www.randomblog.example/a", outletUrl: null }),
      brief,
    );
    expect(a.author_icon).toContain("randomblog.example");
    expect(a.author_name).toBe("Random Blog");
  });

  it("prefers outletUrl over url for the favicon", () => {
    const a = buildAttachment(
      mention({
        sourceName: "Random Blog",
        url: "https://www.clip-aggregator.example/x",
        outletUrl: "https://www.outlethome.example/",
      }),
      brief,
    );
    expect(a.author_icon).toContain("outlethome.example");
  });

  it("leaves author_icon undefined and prefixes a media-type emoji when there is no logo", () => {
    const a = buildAttachment(
      mention({ sourceName: "Nowhere Gazette", mediaType: "radio", url: null, outletUrl: null }),
      brief,
    );
    expect(a.author_icon).toBeUndefined();
    expect(a.author_name).toBe("📻 Nowhere Gazette"); // radio emoji prefix
  });

  it("falls back to 'Unknown source' when sourceName is null and still emits an emoji prefix", () => {
    const a = buildAttachment(
      mention({ sourceName: null, mediaType: null, url: null, outletUrl: null }),
      brief,
    );
    expect(a.author_icon).toBeUndefined();
    expect(a.author_name).toBe("📰 Unknown source"); // null mediaType → default 📰
  });
});

describe("buildAttachment — title & title_link", () => {
  it("sets title_link when a url is present", () => {
    const a = buildAttachment(mention({ url: "https://x.example/a" }), brief);
    expect(a.title).toBe("Big renewable news");
    expect(a.title_link).toBe("https://x.example/a");
  });

  it("leaves title_link undefined when url is absent but keeps the title", () => {
    const a = buildAttachment(mention({ url: null }), brief);
    expect(a.title_link).toBeUndefined();
    expect(a.title).toBe("Big renewable news");
  });

  it("falls back to url then '(untitled)' for the title", () => {
    const withUrl = buildAttachment(mention({ title: null, url: "https://x.example/z" }), brief);
    expect(withUrl.title).toBe("https://x.example/z");
    const untitled = buildAttachment(mention({ title: null, url: null }), brief);
    expect(untitled.title).toBe("(untitled)");
  });
});

describe("buildAttachment — collapse a title that just repeats the masthead", () => {
  it("drops title/title_link and links the heading when the title equals the station name", () => {
    // Real radio case: the program label IS the station name, so both lines read identically.
    const a = buildAttachment(
      mention({
        sourceName: "Triple M Gippsland 94.3 & 97.9",
        title: "Triple M Gippsland 94.3 & 97.9",
        url: "https://mlt.example/track",
        mediaType: "radio",
      }),
      brief,
    );
    expect(a.title).toBeUndefined();
    expect(a.title_link).toBeUndefined();
    expect(a.author_link).toBe("https://mlt.example/track");
    expect(a.author_name).toContain("Triple M Gippsland 94.3 & 97.9");
    expect(a.fallback).toBe("Triple M Gippsland 94.3 & 97.9"); // not "X: X"
  });

  it("collapses across case and whitespace differences (independent sources)", () => {
    const a = buildAttachment(
      mention({ sourceName: "702 ABC Sydney", title: "702  abc   SYDNEY", url: "https://mlt.example/x", mediaType: "radio" }),
      brief,
    );
    expect(a.title).toBeUndefined();
    expect(a.author_link).toBe("https://mlt.example/x");
  });

  it("collapses after the broadcast air-time tail is stripped, and still uses it for the footer date", () => {
    const a = buildAttachment(
      mention({
        sourceName: "Triple M Goulburn Valley 95.3",
        title: "Triple M Goulburn Valley 95.3 - Sat, 11 Jul 2026 00:04:00 +1000",
        url: "https://mlt.example/y",
        mediaType: "radio",
        publishedAt: null,
      }),
      brief,
    );
    expect(a.title).toBeUndefined();
    expect(a.title_link).toBeUndefined();
    expect(a.author_link).toBe("https://mlt.example/y");
    expect(a.footer).toContain("Sat, 11 Jul 2026, 12:04am AEST");
  });

  it("drops the repeated title even with no url, leaving the heading unlinked", () => {
    const a = buildAttachment(
      mention({ sourceName: "Radio Nowhere", title: "Radio Nowhere", url: null, outletUrl: null, mediaType: "radio" }),
      brief,
    );
    expect(a.title).toBeUndefined();
    expect(a.author_link).toBeUndefined();
    expect(a.author_name).toContain("Radio Nowhere");
  });

  it("keeps the separate blue title link when the title differs from the masthead", () => {
    const a = buildAttachment(
      mention({ sourceName: "The Australian", title: "Big renewable news", url: "https://x.example/a" }),
      brief,
    );
    expect(a.title).toBe("Big renewable news");
    expect(a.title_link).toBe("https://x.example/a");
    expect(a.author_link).toBeUndefined();
  });
});

describe("buildAttachment — fields (Author | Organisation Brief)", () => {
  it("includes an Author field when author is present", () => {
    const a = buildAttachment(mention({ author: "Judith Sloan" }), brief);
    expect(a.fields).toEqual([
      { title: "Author", value: "Judith Sloan", short: true },
      { title: "Organisation Brief", value: "Key People", short: true },
    ]);
  });

  it("emits only the Organisation Brief field when author is absent", () => {
    const a = buildAttachment(mention({ author: null }), brief);
    expect(a.fields).toEqual([{ title: "Organisation Brief", value: "Key People", short: true }]);
    expect(a.fields?.some((f) => f.title === "Author")).toBe(false);
  });

  it("escapes mrkdwn in the author and brief label", () => {
    const a = buildAttachment(mention({ author: "A & B" }), { ...brief, label: "R&D <team>" });
    expect(a.fields?.find((f) => f.title === "Author")?.value).toBe("A &amp; B");
    expect(a.fields?.find((f) => f.title === "Organisation Brief")?.value).toBe("R&amp;D &lt;team&gt;");
  });
});

describe("broadcast safety net (unresolved station never shows a person as the outlet)", () => {
  it("maps broadcast media types to a neutral masthead label", () => {
    expect(broadcastMediumLabel("radio")).toBe("Radio");
    expect(broadcastMediumLabel("tv")).toBe("TV");
    expect(broadcastMediumLabel("television")).toBe("TV");
    expect(broadcastMediumLabel(null)).toBe("Radio");
  });

  it("keeps the presenter in the Author byline under a neutral masthead (Zann Maxwell case)", () => {
    const a = buildAttachment(
      mention({ sourceName: "Radio", title: "Evenings with Renee Krosch", author: "Zann Maxwell", mediaType: "radio", url: null, outletUrl: null }),
      brief,
    );
    expect(a.author_name).toBe("📻 Radio"); // medium, not the person
    expect(a.fields?.find((f) => f.title === "Author")?.value).toBe("Zann Maxwell");
  });

  it("drops the Author byline when it just repeats the headline (host-named show, Tom Elliott case)", () => {
    const a = buildAttachment(
      mention({ sourceName: "Radio", title: "Tom Elliott", author: "Tom Elliott", mediaType: "radio", url: null, outletUrl: null }),
      brief,
    );
    expect(a.author_name).toBe("📻 Radio");
    expect(a.fields?.some((f) => f.title === "Author")).toBe(false); // no "Tom Elliott" twice
  });
});

describe("buildAttachment — body text", () => {
  it("renders backtick pills when the snippet contains a brief keyword", () => {
    const a = buildAttachment(
      mention({ snippet: "The renewable rollout and Ross Garnaut said more." }),
      brief,
    );
    expect(a.text).toContain("`renewable`");
    expect(a.text).toContain("`Ross Garnaut`");
  });

  it("surfaces matched keywords absent from the title and snippet as 'also mentions'", () => {
    // Meltwater matches across the whole article but sends a short excerpt, so a matched keyword is
    // often in neither the title nor the snippet. It's surfaced as an "also mentions" pill (real case:
    // the 5th National Whistleblowing Symposium card — Andrew Wilkie / Allegra Spender / MP).
    const a = buildAttachment(
      mention({
        title: "5th National Whistleblowing Symposium",
        snippet: "Speakers include: Assistant Treasurer Dr Daniel Mulino and Senator Paul Scarr.",
        matchedKeywords: ["Andrew Wilkie", "Allegra Spender", "MP"],
      }),
      brief,
    );
    expect(a.text).toContain("Speakers include: Assistant Treasurer Dr Daniel Mulino and Senator Paul Scarr.");
    expect(a.text).toContain("(also mentions `Andrew Wilkie` `Allegra Spender` `MP`)");
    expect(a.text).not.toContain("Mentions:");
  });

  it("does not repeat a matched keyword that is already visible in the title or snippet", () => {
    const a = buildAttachment(
      mention({
        title: "Allegra Spender on Meta AI",
        snippet: "The MP raised concerns.",
        matchedKeywords: ["Allegra Spender", "MP", "Andrew Wilkie"],
      }),
      brief,
    );
    // 'Allegra Spender' is in the title and 'MP' is in the snippet → already visible; only the
    // genuinely-hidden 'Andrew Wilkie' is surfaced.
    expect(a.text).toContain("(also mentions `Andrew Wilkie`)");
    expect(a.text).not.toContain("Allegra Spender");
  });

  it("appends no 'also mentions' suffix when every keyword is already visible in the snippet", () => {
    const a = buildAttachment(
      mention({ title: "Big renewable news", snippet: "The renewable rollout and Ross Garnaut said more." }),
      brief,
    );
    expect(a.text).toContain("`renewable`");
    expect(a.text).toContain("`Ross Garnaut`");
    expect(a.text).not.toContain("also mentions");
  });

  it("surfaces a Meltwater-matched keyword even when it isn't literally in the snippet (Teals card)", () => {
    // Real card: Meltwater matched 'the teals' across the article; our excerpt doesn't contain the
    // phrase. We trust the match and surface it — unmatched brief keywords ('independent') are not.
    const a = buildAttachment(
      mention({
        title: "Labor and teal preferences",
        snippet: "predicting preferences from One Nation, Labor and the",
        matchedKeywords: ["the teals"],
      }),
      { id: "teals", label: "Teals", keywords: ["teal", "independent"] },
    );
    expect(a.text).toContain("predicting preferences from One Nation, Labor and the");
    expect(a.text).toContain("(also mentions `the teals`)");
    expect(a.text).not.toContain("independent");
  });

  it("renders the plain (escaped) snippet when no keyword appears anywhere", () => {
    const a = buildAttachment(
      mention({ title: "Nothing to see", snippet: "A quiet day with < no > keywords." }),
      brief,
    );
    expect(a.text).toBe("A quiet day with &lt; no &gt; keywords.");
    expect(a.text).not.toContain("Mentions:");
    expect(a.text).not.toContain("`");
  });

  it("leaves text undefined when the snippet is empty and nothing else matches", () => {
    const a = buildAttachment(
      mention({ title: "No keywords here", snippet: null }),
      brief,
    );
    expect(a.text).toBeUndefined();
  });

  it("merges payload matchedKeywords with brief keywords for pill highlighting", () => {
    // brief has no keywords, but the payload's matchedKeywords drive the pills.
    const a = buildAttachment(
      mention({ snippet: "A story about teal independents.", matchedKeywords: ["teal"] }),
      { id: "x", label: "Teals", keywords: [] },
    );
    expect(a.text).toContain("`teal`");
  });
});

describe("buildAttachment — footer", () => {
  it("includes date · media type · reach, joined with a middot", () => {
    const a = buildAttachment(mention(), brief);
    expect(a.footer).toContain("Wed, 8 Jul 2026, 8:30am AEST");
    expect(a.footer).toContain("news");
    expect(a.footer).toContain("480K reach");
    expect(a.footer).toContain("·");
  });

  it("shows a thumbs sentiment marker between the media type and the reach", () => {
    const f = buildAttachment(mention({ sentiment: "positive" }), brief).footer!;
    expect(f).toContain("👍");
    expect(f.indexOf("news")).toBeLessThan(f.indexOf("👍"));
    expect(f.indexOf("👍")).toBeLessThan(f.indexOf("480K reach"));
    expect(buildAttachment(mention({ sentiment: "negative" }), brief).footer).toContain("👎");
    expect(buildAttachment(mention({ sentiment: "neutral" }), brief).footer).toContain("😐");
  });

  it("appends 'also matched' and 'Also in' when provided", () => {
    const others = [
      { name: "The Age", url: "https://age.example/b", reach: 40000 },
      { name: "SMH", url: "https://smh.example/c", reach: null },
    ];
    const a = buildAttachment(mention(), brief, others, ["MPs", "Teals"]);
    expect(a.footer).toContain("also matched MPs, Teals");
    expect(a.footer).toContain("Also in: The Age · SMH");
  });

  it("replaces the single reach with '<N> outlets with <sum> combined reach' for multiple outlets", () => {
    const others = [{ name: "The Age", url: "https://age.example/b", reach: 40000 }];
    const a = buildAttachment(mention({ reach: 15000 }), brief, others);
    expect(a.footer).toContain("2 outlets with 55K combined reach");
    expect(a.footer).not.toContain("15K reach");
  });

  it("shows the outlet count with no reach when every outlet's reach is unknown", () => {
    const others = [{ name: "The Age", url: "https://age.example/b", reach: null }];
    const a = buildAttachment(mention({ reach: null }), brief, others);
    expect(a.footer).toContain("2 outlets");
    expect(a.footer).not.toContain("combined reach");
  });

  it("caps 'Also in' at 8 outlets with a '+N more' suffix", () => {
    const outlets = Array.from({ length: 10 }, (_, i) => ({ name: `Outlet${i + 1}`, url: null, reach: null }));
    const a = buildAttachment(mention(), brief, outlets);
    expect(a.footer).toContain("Outlet8");
    expect(a.footer).not.toContain("Outlet9");
    expect(a.footer).toContain("+2 more");
  });

  it("falls back to a broadcast title's air-time for the footer date when publishedAt is null", () => {
    const a = buildAttachment(
      mention({ publishedAt: null, title: "Drive with Jamie Burnett - Wed, 08 Jul 2026 08:30:58 +1000" }),
      brief,
    );
    expect(a.footer).toContain("Wed, 8 Jul 2026, 8:30am AEST");
    expect(a.footer).not.toContain("~"); // an air-time is exact, not approximate
    expect(a.title).toBe("Drive with Jamie Burnett"); // time stripped from the title
  });

  it("falls back to the webhook-receipt time (marked '~') when there is no other date", () => {
    const receivedAt = Date.parse("2026-07-08T07:40:10+10:00");
    const a = buildAttachment(mention({ publishedAt: null }), brief, [], [], receivedAt);
    expect(a.footer).toContain("Wed, 8 Jul 2026, ~7:40am AEST");
  });

  it("prefers the real publish date over the receipt fallback (no '~')", () => {
    const a = buildAttachment(mention(), brief, [], [], Date.parse("2020-01-01T00:00:00+10:00"));
    expect(a.footer).toContain("Wed, 8 Jul 2026, 8:30am AEST");
    expect(a.footer).not.toContain("~");
  });

  it("omits the footer entirely when there is no date, media type, reach, sentiment, receipt, or extras", () => {
    const a = buildAttachment(
      mention({ publishedAt: null, mediaType: null, reach: null, sentiment: null }),
      brief,
    );
    expect(a.footer).toBeUndefined();
  });

  it("always lists 'text' among the mrkdwn_in fields", () => {
    const a = buildAttachment(mention(), brief);
    expect(a.mrkdwn_in).toContain("text");
  });
});

describe("buildAttachment — fallback & color", () => {
  it("builds a masthead:title fallback and uses the default color when the brief has none", () => {
    const a = buildAttachment(mention(), brief);
    expect(a.fallback).toBe("The Australian: Big renewable news");
    expect(a.color).toBe("#868e96"); // DEFAULT_BRIEF_COLOR
  });

  it("uses the brief's own color when set", () => {
    const a = buildAttachment(mention(), { ...brief, color: "#123456" });
    expect(a.color).toBe("#123456");
  });
});

describe("buildPostPayload", () => {
  it("wraps a single attachment with unfurl disabled and no top-level text", () => {
    const p = buildPostPayload(mention(), brief, "C999") as unknown as Record<string, unknown>;
    expect(p.channel).toBe("C999");
    expect(p.text).toBeUndefined();
    expect(p.unfurl_links).toBe(false);
    expect(p.unfurl_media).toBe(false);
    expect(Array.isArray(p.attachments)).toBe(true);
    expect((p.attachments as unknown[]).length).toBe(1);
    expect((p.attachments as { fallback: string }[])[0]!.fallback).toContain("The Australian");
  });
});
