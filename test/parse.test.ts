import { describe, it, expect } from "vitest";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { mastheadForDomain, hostnameOf } from "@/lib/meltwater/outlets";
import { docIdFromLinks } from "@/lib/meltwater/station-resolve";
import type { NormalizedMention } from "@/lib/meltwater/types";

// Meltwater tracking redirects use `?u=<double-encoded real url>`. These fixtures use FAKE
// tracking hosts/tokens; only the embedded `u=` target is meaningful. Helper keeps the fixtures
// readable and guarantees the encoding matches what unwrapTrackingUrl expects (double-encoded).
function trackingUrl(target: string): string {
  return `https://t.fake-notify.example/v2/click?m=webhook&u=${encodeURIComponent(encodeURIComponent(target))}`;
}

describe("mastheadForDomain (outlets.ts)", () => {
  it("matches an exact domain", () => {
    expect(mastheadForDomain("heraldsun.com.au")).toBe("Herald Sun");
  });

  it("matches any subdomain of a known domain", () => {
    expect(mastheadForDomain("www.heraldsun.com.au")).toBe("Herald Sun");
    expect(mastheadForDomain("subscriber.theaustralian.com.au")).toBe("The Australian");
    expect(mastheadForDomain("news.abc.net.au")).toBe("ABC");
  });

  it("does NOT match a suffix that is not a subdomain boundary", () => {
    // "notheraldsun.com.au" ends with "heraldsun.com.au" as a string, but is not a subdomain.
    expect(mastheadForDomain("notheraldsun.com.au")).toBeNull();
  });

  it("returns null for an unknown host or null", () => {
    expect(mastheadForDomain("unknown-outlet.example")).toBeNull();
    expect(mastheadForDomain(null)).toBeNull();
  });

  it("hostnameOf strips www. and lowercases; null on garbage", () => {
    expect(hostnameOf("https://WWW.Example.COM/path?x=1")).toBe("example.com");
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf(null)).toBeNull();
  });
});

describe("docIdFromLinks (station-resolve.ts)", () => {
  it("extracts the docId from a paywall/redirect link in links.article", () => {
    const links = {
      article: trackingUrl("https://app.meltwater.com/paywall/redirect/doc-77aa?ref=x"),
    };
    expect(docIdFromLinks(links)).toBe("doc-77aa");
  });

  it("falls back to links.source when article is missing/unparseable", () => {
    // The fallback (`?? unwrapU(source)`) only kicks in when article can't be unwrapped at all;
    // an article that unwraps but lacks a docId does NOT fall through (the regex just returns null).
    const links = {
      article: null,
      source: trackingUrl("https://app.meltwater.com/paywall/redirect/src-99"),
    };
    expect(docIdFromLinks(links)).toBe("src-99");
  });

  it("returns null when neither link carries a paywall/redirect docId", () => {
    const links = { article: trackingUrl("https://www.example.com/a") };
    expect(docIdFromLinks(links)).toBeNull();
    expect(docIdFromLinks(null)).toBeNull();
    expect(docIdFromLinks(undefined)).toBeNull();
  });
});

describe("parseWebhookPayload — Every Mention reach & keyword parsing", () => {
  function everyMention(overrides: Record<string, unknown> = {}): NormalizedMention {
    const base = {
      type: "Every Mention",
      providerType: "tveyes_radio",
      title: "Program - Wed, 08 Jul 2026 08:04:25 +1000",
      statusLine: "🔊 1.59M Reach — 😔 Negative Sentiment",
      source: "MPs",
      keywords: "MP, Andrew Wilkie",
      authorName: "Herald Sun",
      text: "Some clip text.",
      links: {
        article: trackingUrl("https://www.heraldsun.com.au/a"),
        source: trackingUrl("https://www.heraldsun.com.au/"),
      },
    };
    const [m] = parseWebhookPayload({ ...base, ...overrides });
    return m!;
  }

  it("parses megabyte-scale reach from the status line (1.59M → 1590000)", () => {
    expect(everyMention().reach).toBe(1590000);
  });

  it("parses kilo-scale reach (20.42k → 20420)", () => {
    const m = everyMention({ statusLine: "🔊 20.42k Reach — 🙂 Positive Sentiment" });
    expect(m.reach).toBe(20420);
    expect(m.sentiment).toBe("positive");
  });

  it("returns null reach when the status line has no reach token", () => {
    const m = everyMention({ statusLine: "😐 Neutral Sentiment" });
    expect(m.reach).toBeNull();
    expect(m.sentiment).toBe("neutral");
  });

  it("splits matchedKeywords from a comma string", () => {
    expect(everyMention().matchedKeywords).toEqual(["MP", "Andrew Wilkie"]);
  });

  it("normalizeMedium maps tveyes_radio → radio", () => {
    expect(everyMention().mediaType).toBe("radio");
  });

  it("keeps the tracking url as-is and unwraps outletUrl", () => {
    const m = everyMention();
    expect(m.url).toContain("t.fake-notify.example"); // licensed/tracking link kept verbatim
    expect(m.outletUrl).toBe("https://www.heraldsun.com.au/");
    expect(m.briefName).toBe("MPs"); // `source` = brief
  });
});

describe("parseWebhookPayload — Every Mention outlet vs byline resolution", () => {
  it("when authorName equals the masthead, sourceName is the masthead and author is null", () => {
    // Domain resolves to "Herald Sun"; authorName is also "Herald Sun" → not a distinct byline.
    const [m] = parseWebhookPayload({
      providerType: "online_news",
      statusLine: "🔊 480k Reach",
      source: "MPs",
      keywords: "MP",
      authorName: "Herald Sun",
      links: {
        article: trackingUrl("https://www.heraldsun.com.au/a"),
        source: trackingUrl("https://www.heraldsun.com.au/"),
      },
    });
    expect(m!.sourceName).toBe("Herald Sun");
    expect(m!.author).toBeNull();
  });

  it("when the domain is unknown, sourceName falls back to authorName and author is null", () => {
    const [m] = parseWebhookPayload({
      providerType: "online_news",
      statusLine: "🔊 10k Reach",
      source: "MPs",
      authorName: "Some Local Rag",
      links: {
        article: trackingUrl("https://www.unknown-outlet.example/a"),
        source: trackingUrl("https://www.unknown-outlet.example/"),
      },
    });
    expect(m!.sourceName).toBe("Some Local Rag");
    expect(m!.author).toBeNull(); // no masthead → nothing to promote a byline against
  });

  it("strips trailing '(Print version)' and '(Licensed by Copyright Agency)' cruft from authorName", () => {
    // Unknown domain so sourceName IS the cleaned authorName (masthead path would replace it).
    const [m] = parseWebhookPayload({
      providerType: "print",
      statusLine: "🔊 10k Reach",
      source: "MPs",
      authorName: "Jane Doe (Print version) (Licensed by Copyright Agency)",
      links: {
        article: trackingUrl("https://www.unknown-outlet.example/a"),
        source: trackingUrl("https://www.unknown-outlet.example/"),
      },
    });
    expect(m!.sourceName).toBe("Jane Doe");
  });

  it("promotes the byline to author when domain masthead differs from authorName", () => {
    const [m] = parseWebhookPayload({
      providerType: "online_news",
      statusLine: "🔊 480k Reach",
      source: "Teals",
      authorName: "Jim O'Rourke (Licensed by Copyright Agency)",
      links: {
        article: trackingUrl("https://www.smh.com.au/politics/a"),
        source: trackingUrl("https://www.smh.com.au/"),
      },
    });
    expect(m!.sourceName).toBe("The Sydney Morning Herald");
    expect(m!.author).toBe("Jim O'Rourke");
  });

  it("recognises the Every Mention shape via providerType+statusLine without an explicit type", () => {
    const [m] = parseWebhookPayload({
      providerType: "tveyes_tv",
      statusLine: "🔊 2.5M Reach",
      source: "Vic State",
      authorName: "The Age",
      links: {
        article: trackingUrl("https://www.theage.com.au/a"),
        source: trackingUrl("https://www.theage.com.au/"),
      },
    });
    expect(m!.mediaType).toBe("tv");
    expect(m!.reach).toBe(2500000);
    expect(m!.sourceName).toBe("The Age");
  });
});

describe("parseWebhookPayload — structured documents[] shape", () => {
  it("parses source_name / document_author / document_url / source_reach", () => {
    const [m] = parseWebhookPayload({
      documents: [
        {
          document_url: "https://x.example/story",
          document_title: "A headline",
          source_name: "The Australian",
          source_information_type: "news",
          source_country_code: "AU",
          source_reach: 480000,
          document_author: "Judith Sloan",
        },
      ],
    });
    expect(m!.url).toBe("https://x.example/story");
    expect(m!.title).toBe("A headline");
    expect(m!.sourceName).toBe("The Australian");
    expect(m!.mediaType).toBe("news");
    expect(m!.countryCode).toBe("AU");
    expect(m!.reach).toBe(480000);
    expect(m!.author).toBe("Judith Sloan");
    expect(m!.outletUrl).toBeNull(); // only the Every Mention path sets outletUrl
  });

  it("parses reach given as a formatted string (source_reach: '1,200,000')", () => {
    const [m] = parseWebhookPayload({
      documents: [{ source_name: "SMH", source_reach: "1,200,000" }],
    });
    expect(m!.reach).toBe(1200000);
  });
});

describe("parseWebhookPayload — defensive extraction", () => {
  it("reads documents from alternate array containers", () => {
    for (const key of ["results", "mentions", "items", "data"]) {
      const m = parseWebhookPayload({ [key]: [{ source_name: `via-${key}` }] });
      expect(m).toHaveLength(1);
      expect(m[0]!.sourceName).toBe(`via-${key}`);
    }
  });

  it("reads a bare top-level array of documents", () => {
    const m = parseWebhookPayload([
      { source_name: "One" },
      { source_name: "Two" },
    ]);
    expect(m.map((x) => x.sourceName)).toEqual(["One", "Two"]);
  });

  it("unwraps a nested source.name object into sourceName", () => {
    const [m] = parseWebhookPayload({
      documents: [{ source: { name: "Nested Outlet" }, document_url: "https://x.example/n" }],
    });
    expect(m!.sourceName).toBe("Nested Outlet");
  });

  it("inherits the top-level brief name when a doc lacks its own", () => {
    const [m] = parseWebhookPayload({
      search_name: "Climate 200",
      documents: [{ source_name: "The Age" }],
    });
    expect(m!.briefName).toBe("Climate 200");
  });

  it("treats a single-document object (no array container) as one mention", () => {
    const m = parseWebhookPayload({ source_name: "Solo", document_url: "https://x.example/s" });
    expect(m).toHaveLength(1);
    expect(m[0]!.sourceName).toBe("Solo");
  });

  it("fills missing fields with null / empty and never throws on a sparse doc", () => {
    const [m] = parseWebhookPayload({ documents: [{}] });
    expect(m!.url).toBeNull();
    expect(m!.sourceName).toBeNull();
    expect(m!.reach).toBeNull();
    expect(m!.sentiment).toBeNull();
    expect(m!.publishedAt).toBeNull();
    expect(m!.author).toBeNull();
    expect(m!.matchedKeywords).toEqual([]);
    expect(m!.briefName).toBeNull();
  });

  it("returns [] for a non-object, non-array payload", () => {
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload("nope")).toEqual([]);
  });

  it("parses an ISO publish date into ISO-8601", () => {
    const [m] = parseWebhookPayload({
      documents: [{ source_name: "X", document_publish_date: "2026-07-08T08:30:00+10:00" }],
    });
    expect(m!.publishedAt).toBe("2026-07-07T22:30:00.000Z"); // +10:00 → 22:30Z the previous day
  });
});
