import { describe, it, expect } from "vitest";
import { buildAttachment, buildPostPayload } from "@/lib/slack/format";
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

describe("buildAttachment — body text", () => {
  it("renders backtick pills when the snippet contains a brief keyword", () => {
    const a = buildAttachment(
      mention({ snippet: "The renewable rollout and Ross Garnaut said more." }),
      brief,
    );
    expect(a.text).toContain("`renewable`");
    expect(a.text).toContain("`Ross Garnaut`");
  });

  it("uses a 'Mentions:' line when the keyword is only in the title, not the snippet", () => {
    const a = buildAttachment(
      mention({ title: "Renewable push", snippet: "No matching term here at all." }),
      brief,
    );
    // buildMentionsLine runs over title+snippet, so the title keyword produces a Mentions line.
    expect(a.text).toContain("Mentions:");
    expect(a.text).toContain("`renewable (1)`");
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

  it("appends 'also matched' and 'Also in' when provided", () => {
    const a = buildAttachment(mention(), brief, ["The Age", "SMH"], ["MPs", "Teals"]);
    expect(a.footer).toContain("also matched MPs, Teals");
    expect(a.footer).toContain("Also in: The Age · SMH");
  });

  it("caps 'Also in' at 8 outlets with a '+N more' suffix", () => {
    const outlets = Array.from({ length: 10 }, (_, i) => `Outlet${i + 1}`);
    const a = buildAttachment(mention(), brief, outlets);
    expect(a.footer).toContain("Outlet8");
    expect(a.footer).not.toContain("Outlet9");
    expect(a.footer).toContain("+2 more");
  });

  it("omits the footer entirely when there is no date, media type, reach, or extras", () => {
    const a = buildAttachment(
      mention({ publishedAt: null, mediaType: null, reach: null }),
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
