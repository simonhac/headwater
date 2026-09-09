import { describe, it, expect } from "vitest";
import { parseWebhookPayload, tidySnippet } from "@/lib/meltwater/parse";
import { mastheadForDomain, hostnameOf, deriveOutletName, looksLikePerson } from "@/lib/meltwater/outlets";
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

  it("returns the verified masthead for the pass-one additions, verbatim", () => {
    expect(mastheadForDomain("sbs.com.au")).toBe("SBS News"); // initialism, not "Sbs"
    expect(mastheadForDomain("canberratimes.com.au")).toBe("The Canberra Times"); // leading "The"
    expect(mastheadForDomain("marieclaire.com.au")).toBe("marie claire"); // lower-case brand kept
    // Not derivable from the domain at all — guards against anyone "simplifying" these back.
    expect(mastheadForDomain("theherald.com.au")).toBe("Newcastle Herald");
    expect(mastheadForDomain("theleader.com.au")).toBe("St George & Sutherland Shire Leader");
  });

  it("keys the two Yahoo properties separately so neither inherits the other's name", () => {
    // A single "yahoo.com" entry would match both (subdomains inherit) and label Finance as News.
    expect(mastheadForDomain("au.news.yahoo.com")).toBe("Yahoo News Australia");
    expect(mastheadForDomain("au.finance.yahoo.com")).toBe("Yahoo Finance Australia");
    expect(mastheadForDomain("yahoo.com")).toBeNull();
  });

  it("resolves mastheads the domain gives no clue about (pass two)", () => {
    expect(mastheadForDomain("kalminer.com.au")).toBe("Kalgoorlie Miner"); // abbreviated domain
    expect(mastheadForDomain("thegazette.com.au")).toBe("The Warragul & Drouin Gazette");
    expect(mastheadForDomain("ulladullatimes.com.au")).toBe("Milton Ulladulla Times");
    expect(mastheadForDomain("radioinfo.com.au")).toBe("radioinfo"); // lower-case brand, like marie claire
  });

  it("keys the two Newcastle Herald domains and the Star Weekly editions precisely", () => {
    // Nine kept the legacy theherald.com.au (it 301s to smh.com.au) while ACM publishes at
    // newcastleherald.com.au; Meltwater still cites both, and both are the same masthead.
    expect(mastheadForDomain("theherald.com.au")).toBe("Newcastle Herald");
    expect(mastheadForDomain("newcastleherald.com.au")).toBe("Newcastle Herald");
    // Star Weekly is keyed per edition subdomain — a bare starweekly.com.au would mislabel the rest.
    expect(mastheadForDomain("maribyrnonghobsonsbay.starweekly.com.au")).toBe("Maribyrnong & Hobsons Bay Star Weekly");
    expect(mastheadForDomain("starweekly.com.au")).toBeNull();
  });

  it("maps The Sun-Herald from the unrelated US domain Meltwater cites for it", () => {
    // Not a mistake: the SMH's Sunday masthead has no domain of its own, so Meltwater points at the
    // Biloxi paper's sunherald.com. Every archived item is a Sunday print drop bylined by SMH staff.
    expect(mastheadForDomain("sunherald.com")).toBe("The Sun-Herald");
  });

  it("leaves multi-masthead publishers unmapped", () => {
    // Active Networks publishes Peninsula Living, North Shore Living and Think Local — a mapped name
    // wins over authorName, so mapping the domain would stamp the wrong magazine on their articles.
    expect(mastheadForDomain("activenetworks.com.au")).toBeNull();
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

  it("recovers the outlet from an unmapped publisher domain and demotes authorName to the byline", () => {
    const [m] = parseWebhookPayload({
      providerType: "online_news",
      statusLine: "🔊 10k Reach",
      source: "MPs",
      authorName: "Jane Reporter",
      links: {
        article: trackingUrl("https://www.some-local-news.com.au/a"),
        source: trackingUrl("https://www.some-local-news.com.au/"),
      },
    });
    expect(m!.sourceName).toBe("Some Local News"); // derived from the domain, not in the table
    expect(m!.author).toBe("Jane Reporter"); // byline moved to the Author field
  });

  it("keeps authorName as the header when it names an unmapped domain (outlet, not a byline)", () => {
    // bendigoadvertiser.com.au isn't in the table, but authorName IS the outlet — don't demote it to
    // a byline or show a mangled domain-derived header.
    const [m] = parseWebhookPayload({
      providerType: "online_news",
      statusLine: "🔊 10k Reach",
      source: "MPs",
      authorName: "Bendigo Advertiser",
      links: { source: trackingUrl("https://www.bendigoadvertiser.com.au/") },
    });
    expect(m!.sourceName).toBe("Bendigo Advertiser");
    expect(m!.author).toBeNull();
  });

  it("strips trailing '(Print version)' and '(Licensed by Copyright Agency)' cruft from authorName", () => {
    // No publisher host → status quo: sourceName IS the cleaned authorName.
    const [m] = parseWebhookPayload({
      providerType: "print",
      statusLine: "🔊 10k Reach",
      source: "MPs",
      authorName: "Jane Doe (Print version) (Licensed by Copyright Agency)",
      links: {},
    });
    expect(m!.sourceName).toBe("Jane Doe");
    expect(m!.author).toBeNull();
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

describe("deriveOutletName (outlets.ts)", () => {
  it("title-cases a hyphenated domain into a multi-word name", () => {
    expect(deriveOutletName("some-local-news.com.au")).toBe("Some Local News");
  });

  it("handles a single-label domain", () => {
    expect(deriveOutletName("nine.com.au")).toBe("Nine");
  });

  it("drops a generic leading subdomain and returns null for garbage", () => {
    expect(deriveOutletName("www.crikey.com.au")).toBe("Crikey");
    expect(deriveOutletName(null)).toBeNull();
    expect(deriveOutletName("")).toBeNull();
  });
});

describe("looksLikePerson (outlets.ts)", () => {
  it("accepts 2–3 capitalised words with no outlet word (incl. O'/hyphenated surnames)", () => {
    expect(looksLikePerson("Jorge Branco")).toBe(true);
    expect(looksLikePerson("Lucinda Garbutt-Young")).toBe(true);
    expect(looksLikePerson("Jim O'Rourke")).toBe(true);
  });

  it("rejects masthead-like names (outlet words, 'The', 4+ words, all-caps)", () => {
    expect(looksLikePerson("Chelsea Mordialloc Mentone News")).toBe(false); // 4 words + 'News'
    expect(looksLikePerson("The Sentinel")).toBe(false); // leading 'The'
    expect(looksLikePerson("News of the Midlands")).toBe(false);
    expect(looksLikePerson("ABC")).toBe(false); // single all-caps token
    expect(looksLikePerson("Transparency International Australia")).toBe(false); // 'Australia'
    expect(looksLikePerson(null)).toBe(false);
  });

  it("rejects parliamentary source names (aph.gov.au sends these as authorName)", () => {
    // Three capitalised words with no outlet word, so this used to read as a byline and the card
    // headlined the domain-derived "Aph" instead.
    expect(looksLikePerson("Senate Official Hansard")).toBe(false);
    expect(looksLikePerson("House of Representatives Official Hansard")).toBe(false);
  });
});

describe("parseWebhookPayload — outlet recovery from the publisher domain (real cases)", () => {
  // These mirror three production items where authorName is the journalist, not the outlet.
  it("maps nine.com.au → 9News, moving the reporter to Author", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 8M Reach — 😐 Neutral Sentiment",
      source: "MPs",
      authorName: "Jorge Branco",
      links: {
        source: trackingUrl("https://www.nine.com.au/"),
        article: trackingUrl("https://transition.meltwater.com/paywall/redirect/abc?productType=alerts"),
      },
    });
    expect(m!.sourceName).toBe("9News");
    expect(m!.author).toBe("Jorge Branco");
  });

  it("maps ajn.timesofisrael.com → The Australian Jewish News", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "👍 192k Reach",
      source: "MPs",
      authorName: "Gareth Narunsky",
      links: {
        source: trackingUrl("https://ajn.timesofisrael.com/"),
        article: trackingUrl("https://app.meltwater.com/shareddocumentviewer/v2/xyz"),
      },
    });
    expect(m!.sourceName).toBe("The Australian Jewish News");
    expect(m!.author).toBe("Gareth Narunsky");
  });

  it("keeps a masthead-like authorName instead of deriving an ugly name from the domain", () => {
    // baysidenews.com.au isn't in the table; authorName is a masthead, not a person → keep it as-is
    // (regression from the dry-run: "Chelsea Mordialloc Mentone News" was mangled to "Baysidenews").
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 5k Reach",
      source: "MPs",
      authorName: "Chelsea Mordialloc Mentone News",
      links: { source: trackingUrl("https://www.baysidenews.com.au/a") },
    });
    expect(m!.sourceName).toBe("Chelsea Mordialloc Mentone News");
    expect(m!.author).toBeNull();
  });

  it("maps a journalist byline on a newly-listed masthead (themercury.com.au → The Mercury)", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 200k Reach",
      source: "MPs",
      authorName: "Jared Lynch",
      links: { source: trackingUrl("https://www.themercury.com.au/a") },
    });
    expect(m!.sourceName).toBe("The Mercury");
    expect(m!.author).toBe("Jared Lynch");
  });

  it("maps a byline on a newly-listed masthead (bordermail.com.au → The Border Mail)", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 40k Reach",
      source: "MPs",
      authorName: "Anthony Bunn",
      links: { source: trackingUrl("https://www.bordermail.com.au/") },
    });
    expect(m!.sourceName).toBe("The Border Mail");
    expect(m!.author).toBe("Anthony Bunn");
  });

  it("is idempotent when Meltwater already sent the masthead on a mapped domain", () => {
    // Print mentions arrive as "The Border Mail (Print version)" — cleanOutletName strips the
    // annotation, the map yields the same string, so the byline stays empty rather than echoing it.
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 40k Reach",
      source: "MPs",
      authorName: "The Border Mail (Print version)",
      links: { source: trackingUrl("https://www.bordermail.com.au/") },
    });
    expect(m!.sourceName).toBe("The Border Mail");
    expect(m!.author).toBeNull();
  });

  it("keeps the Hansard name instead of deriving 'Aph' from the domain", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 1k Reach",
      source: "MPs",
      authorName: "Senate Official Hansard (Print version)",
      links: { source: trackingUrl("https://www.aph.gov.au/") },
    });
    expect(m!.sourceName).toBe("Senate Official Hansard"); // NOT "Aph", and not flattened to a
    expect(m!.author).toBeNull(); //                          single "Parliament of Australia"
  });

  it("labels a party media release from liberal.org.au", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 10k Reach",
      source: "MPs",
      authorName: "Angus Taylor",
      links: { source: trackingUrl("https://www.liberal.org.au/a") },
    });
    expect(m!.sourceName).toBe("Liberal Party Media Release");
    expect(m!.author).toBe("Angus Taylor");
  });

  it("falls back to the article link's domain when links.source is a Meltwater host", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "👎 1.7k Reach — 😔 Negative Sentiment",
      source: "Teals",
      authorName: "Tess Ikonomou",
      links: {
        source: trackingUrl("https://app.meltwater.com/x"),
        article: trackingUrl("https://www.australianconveyancer.com.au/article/column-of-smoke/"),
      },
    });
    expect(m!.sourceName).toBe("Australian Conveyancer");
    expect(m!.author).toBe("Tess Ikonomou");
  });

  it("keeps authorName as the header when only Meltwater hosts are present (status quo)", () => {
    const [m] = parseWebhookPayload({
      providerType: "news",
      statusLine: "😐 5k Reach",
      source: "MPs",
      authorName: "Some Wire Service",
      links: {
        source: trackingUrl("https://app.meltwater.com/x"),
        article: trackingUrl("https://transition.meltwater.com/paywall/redirect/y"),
      },
    });
    expect(m!.sourceName).toBe("Some Wire Service");
    expect(m!.author).toBeNull();
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

describe("tidySnippet", () => {
  it("drops a severed sentence-ending mark, leaving a clean sentence start", () => {
    expect(tidySnippet(". The message we will send is that there is no consequence")).toBe(
      "The message we will send is that there is no consequence\u2026",
    );
    expect(tidySnippet("? So many of the stations we listen to")).toBe("So many of the stations we listen to\u2026");
    expect(tidySnippet("! Right then")).toBe("Right then\u2026");
  });

  it("marks a severed clause with an ellipsis \u2014 the reader IS mid-thought", () => {
    expect(tidySnippet(", Mums for Nuclear. There's a whole lot of them")).toBe(
      "\u2026Mums for Nuclear. There's a whole lot of them\u2026",
    );
    expect(tidySnippet(": Issue 657 August 1")).toBe("\u2026Issue 657 August 1\u2026");
    expect(tidySnippet("; and then some")).toBe("\u2026and then some\u2026");
  });

  it("normalizes Meltwater's own `...` marker to a single ellipsis", () => {
    // 733 of 1525 stored snippets lead with their marker and 872 end with one. It's not a defect,
    // but leaving it as three dots puts two glyphs side by side on the same card.
    expect(tidySnippet("...the legislation, now before a Senate inquiry")).toBe(
      "\u2026the legislation, now before a Senate inquiry\u2026",
    );
    expect(tidySnippet("\u2026already elided")).toBe("\u2026already elided\u2026");
    expect(tidySnippet("...Speakers include: Dr Daniel Mulino and Senator Paul Scarr Andrew...")).toBe(
      "\u2026Speakers include: Dr Daniel Mulino and Senator Paul Scarr Andrew\u2026",
    );
    expect(tidySnippet("cut here ....")).toBe("\u2026cut here\u2026");
  });

  it("marks an unmarked mid-sentence start \u2014 lowercase, digit, or a cut contraction", () => {
    // 433 of 1525 start lowercase with no marker at all; 14 start on a digit. The apostrophe cases
    // are the window landing inside a contraction: "it's" \u2192 "'s", "haven't" \u2192 "'t".
    expect(tidySnippet("a new gambling licence to online bookmaker")).toBe(
      "\u2026a new gambling licence to online bookmaker\u2026",
    );
    expect(tidySnippet("2019 was the year")).toBe("\u20262019 was the year\u2026");
    expect(tidySnippet("'s important to as I say have these conv")).toBe(
      "\u2026's important to as I say have these conv\u2026",
    );
  });

  it("handles debris the whitespace-only rule used to miss", () => {
    // A clause mark closed by a quote (no space before it), and a word split across the window edge.
    expect(tidySnippet(",\u201d he said. \u201cTheir longest-serving MP thinks the")).toBe(
      "\u2026he said. \u201cTheir longest-serving MP thinks the\u2026",
    );
    expect(tidySnippet("-free zone at the moment. They've really struggl")).toBe(
      "\u2026free zone at the moment. They've really struggl\u2026",
    );
    // Dropping the severed full stop can still leave a lowercase start \u2014 mark that too.
    expect(tidySnippet(". farming salmon in Long Bay, after the EPA rene")).toBe(
      "\u2026farming salmon in Long Bay, after the EPA rene\u2026",
    );
  });

  it("marks a tail cut mid-sentence, and replaces severed clause punctuation", () => {
    // 536 of 1525 end on a bare word, 19 on a comma \u2014 Meltwater just stops.
    expect(tidySnippet("Predicting preferences from One Nation, Labor and the")).toBe(
      "Predicting preferences from One Nation, Labor and the\u2026",
    );
    expect(tidySnippet("They're pretty much all in a metropolitan of t,")).toBe(
      "They're pretty much all in a metropolitan of t\u2026",
    );
    expect(tidySnippet("The rollout is inevitable \u2014")).toBe("The rollout is inevitable\u2026");
  });

  it("leaves a complete sentence's tail alone, including inside a quote", () => {
    expect(tidySnippet("A quick look at today's papers.")).toBe("A quick look at today's papers.");
    expect(tidySnippet('He said it was "a disgrace."')).toBe('He said it was "a disgrace."');
    expect(tidySnippet("Is that so?")).toBe("Is that so?");
  });

  it("leaves an uppercase start untouched \u2014 we cannot tell a proper noun from a sentence", () => {
    expect(tidySnippet("The premier said today.")).toBe("The premier said today.");
    expect(tidySnippet("\u201cThe premier said today")).toBe("\u201cThe premier said today\u2026");
    // A decimal or abbreviation must not be mistaken for a severed sentence: the rule requires
    // whitespace (or a closing quote) after the mark.
    expect(tidySnippet(".NET developers rejoice.")).toBe(".NET developers rejoice.");
    expect(tidySnippet("1.5 degrees of warming.")).toBe("\u20261.5 degrees of warming.");
  });

  it("is idempotent \u2014 the repair sweep must not churn cards on a re-run", () => {
    // Verified against all 195 snippets in the live 7-day window. The case that first broke this:
    // a marker followed by a cut contraction, where swallowing the apostrophe as a "closing quote"
    // turned "\u2026's important" into "\u2026s important" on the second pass.
    for (const s of [
      "...'s important to as I say have these conv",
      "\u2026's important to as I say have these conv",
      ". The message we will send",
      ",\u201d he said. \u201cTheir longest-serving MP thinks the",
      "-free zone at the moment",
      "They're pretty much all in a metropolitan of t,",
      'He said it was "a disgrace."',
      ".NET developers rejoice.",
    ]) {
      expect(tidySnippet(tidySnippet(s))).toBe(tidySnippet(s));
    }
  });

  it("passes null/empty straight through", () => {
    expect(tidySnippet(null)).toBeNull();
    expect(tidySnippet("")).toBe("");
    expect(tidySnippet(". ")).toBeNull();
    expect(tidySnippet("...")).toBeNull();
  });
});
