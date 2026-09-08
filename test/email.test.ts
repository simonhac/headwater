import { describe, it, expect } from "vitest";
import type { SlackAttachment } from "@/lib/slack/format";
import { emailMrkdwn, renderEmailTile, renderDigestEmail, renderDigestText, compactReachText } from "@/ui/email";
import { buildDigestModel, combinedReach, colorForBriefLabel, digestIdentity } from "@/lib/digest";
import type { StoryRow } from "@/lib/story";

// Test window: comfortably brackets every fixture's created_at, with real (formattable) timestamps.
const WINDOW_END = Date.UTC(2026, 5, 18);

// A complete attachment with sensible defaults; override per-test via `over`.
function att(over: Partial<SlackAttachment> = {}): SlackAttachment {
  return {
    color: "#f76707",
    fallback: "The Age: Something happened",
    author_name: "The Age — Rob Harris",
    author_icon: "https://www.google.com/s2/favicons?sz=64&amp;domain=theage.com.au",
    title: "Something happened",
    title_link: "https://app.meltwater.com/mm/redirect/abc",
    text: "A snippet mentioning `Climate 200` today.",
    footer: "Thu, 11 Jun 2026, 6:02am AEST  ·  Brief: Climate 200 😐  ·  5M reach",
    footer_icon: "https://feed.moofer.com/icons/media/v1/globe.png",
    mrkdwn_in: ["text"],
    ...over,
  };
}

describe("emailMrkdwn — the email twin of mrkdwnText", () => {
  it("turns a backtick code span into an inline-styled pill (no class)", () => {
    const out = emailMrkdwn("A shift `Climate 200` warned about.");
    expect(out).toContain("<code style=");
    expect(out).toContain(">Climate 200</code>");
    expect(out).not.toContain("sr-inline-code");
    expect(out).toContain("color:rgb(192,19,67)"); // the pill colour must survive inlining
  });

  it("does NOT re-escape already-escaped entities (no double-encode)", () => {
    const input = "A quiet day with &lt; no &gt; keywords &amp; more.";
    expect(emailMrkdwn(input)).toBe(input);
    expect(emailMrkdwn(input)).not.toContain("&amp;lt;");
  });

  it("renders the trailing ↗ go-direct link as an inline-styled anchor", () => {
    expect(emailMrkdwn("Body. <https://abc.net.au/x?a=1&amp;b=2|↗>")).toBe(
      'Body. <a href="https://abc.net.au/x?a=1&amp;b=2" style="color:#1264a3; text-decoration:none;">↗</a>',
    );
  });

  it("does not linkify a non-http(s) target", () => {
    expect(emailMrkdwn("<javascript:alert(1)|x>")).toBe("<javascript:alert(1)|x>");
  });

  it("leaves a lone stray backtick literal", () => {
    expect(emailMrkdwn("a ` b")).toBe("a ` b");
  });
});

describe("renderEmailTile", () => {
  it("renders masthead, headline, excerpt and footer from the attachment", () => {
    const html = renderEmailTile(att());
    expect(html).toContain("The Age — Rob Harris");
    expect(html).toContain("Something happened");
    expect(html).toContain("https://app.meltwater.com/mm/redirect/abc");
    expect(html).toContain("Brief: Climate 200 😐");
    expect(html).toContain("https://feed.moofer.com/icons/media/v1/globe.png");
  });

  it("paints the brief colour as a border-left, not a ::before pseudo-element", () => {
    expect(renderEmailTile(att({ color: "#0ca678" }))).toContain("border-left:4px solid #0ca678");
  });

  it("falls back to the default grey bar for a non-hex colour", () => {
    expect(renderEmailTile(att({ color: "javascript:alert(1)" }))).toContain("border-left:4px solid #868e96");
  });

  it("collapsed broadcast variant: no title, masthead itself carries the link", () => {
    const html = renderEmailTile(
      att({ title: undefined, title_link: undefined, author_link: "https://app.meltwater.com/mm/redirect/z", author_name: "7 Albury" }),
    );
    expect(html).toContain('<a href="https://app.meltwater.com/mm/redirect/z"');
    expect(html).toContain("7 Albury");
    // The headline row must be absent entirely, not an empty div.
    expect(html).not.toContain("margin:2px 0 4px 0;");
  });

  it("escapes a hostile author_name / title", () => {
    const html = renderEmailTile(att({ author_name: '<img src=x onerror="alert(1)">', title: "<script>bad()</script>" }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops a non-http(s) title_link rather than emitting it as an href", () => {
    const html = renderEmailTile(att({ title_link: "javascript:alert(1)" }));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Something happened");
  });

  it("omits the footer row when there is no footer", () => {
    expect(renderEmailTile(att({ footer: undefined }))).not.toContain("margin-top:6px;");
  });
});

describe("renderDigestEmail — email safety", () => {
  const digest = buildDigestModel(
    [row({ story_key: "a", brief_labels_json: '["Climate 200"]', outlets_json: '[{"name":"The Age","url":null,"reach":5000000}]' })],
    0,
    WINDOW_END,
  );

  it("emits no constructs that Gmail/Outlook strip", () => {
    const html = renderDigestEmail(digest);
    for (const banned of ["display:flex", "display:grid", "::before", "var(--", "position:absolute", "@import", "<link"]) {
      expect(html).not.toContain(banned);
    }
  });

  it("carries exactly one <style> block, holding only the max-width rule", () => {
    const html = renderDigestEmail(digest);
    expect(html.match(/<style/g) ?? []).toHaveLength(1);
    expect(html).toContain("max-width: 660px");
  });

  it("renders the section header with the brief colour and story count", () => {
    const html = renderDigestEmail(digest);
    expect(html).toContain("CLIMATE 200");
    expect(html).toContain("#f76707");
    expect(html).toContain("1 story"); // singular, not "1 stories"
  });

  it("produces a text/plain alternative carrying the same headline and footer", () => {
    const text = renderDigestText(digest);
    expect(text).toContain("CLIMATE 200");
    expect(text).toContain("Something happened");
    expect(text).not.toContain("<td");
  });
});

describe("compactReachText", () => {
  it("matches compactReach's format", () => {
    expect(compactReachText(5_000_000)).toBe("5M");
    expect(compactReachText(1_116_000)).toBe("1.1M");
    expect(compactReachText(616_000)).toBe("616K");
    expect(compactReachText(85_200)).toBe("85.2K");
    expect(compactReachText(400)).toBe("400");
  });
});

describe("buildDigestModel", () => {
  it("groups by primary brief and orders sections + tiles by reach desc", () => {
    const d = buildDigestModel(
      [
        row({ story_key: "small", brief_labels_json: '["Teals"]', outlets_json: '[{"name":"Capital Brief","url":null,"reach":85200}]' }),
        row({ story_key: "big", brief_labels_json: '["Climate 200"]', outlets_json: '[{"name":"SMH","url":null,"reach":5000000}]' }),
        row({ story_key: "mid", brief_labels_json: '["Climate 200"]', outlets_json: '[{"name":"Herald Sun","url":null,"reach":513000}]' }),
      ],
      0,
      WINDOW_END,
    );
    expect(d.sections.map((s) => s.label)).toEqual(["Climate 200", "Teals"]);
    expect(d.sections[0]!.tiles.map((t) => t.storyKey)).toEqual(["big", "mid"]);
    expect(d.sections[0]!.totalReach).toBe(5_513_000);
    expect(d.storyCount).toBe(3);
  });

  it("excludes stories created outside the window even though updatedSince returned them", () => {
    // The recurrence bug this guards: an old story that merely gained an outlet inside the window.
    const old = row({ story_key: "old", created_at: 1_000, updated_at: 9_000 });
    const fresh = row({ story_key: "fresh", created_at: 5_000, updated_at: 9_000 });
    const d = buildDigestModel([old, fresh], 4_000, 8_000);
    expect(d.storyCount).toBe(1);
    expect(d.sections[0]!.tiles[0]!.storyKey).toBe("fresh");
  });

  // Multi-channel fanout (simonhac/vic-election-slack-fanout) re-keys stories as
  // "<channel>|<sha256(title)>", so one headline routed to N channels becomes N rows. These pin the
  // digest to one tile per story either side of that merge.
  it("extracts the title hash from every story_key shape", () => {
    expect(digestIdentity("abc123")).toBe("abc123");                    // original bare hash
    expect(digestIdentity("C_ALL|abc123")).toBe("abc123");              // channel|hash
    expect(digestIdentity("C_ALL|abc123|1757310000000")).toBe("abc123"); // + posting instance
  });

  it("ignores the trailing createdAt, so repeat postings of one headline still fold", () => {
    const d = buildDigestModel(
      [
        row({ story_key: "C_ALL|dupe|1757310000000", created_at: 5_000 }),
        row({ story_key: "C_ALL|dupe|1757396400000", created_at: 6_000 }),
      ],
      0,
      WINDOW_END,
    );
    expect(d.storyCount).toBe(1);
  });

  it("does not fold two different stories created in the same millisecond", () => {
    const d = buildDigestModel(
      [
        row({ story_key: "C_ALL|aaa|1757310000000", created_at: 5_000 }),
        row({ story_key: "C_ALL|bbb|1757310000000", created_at: 5_000 }),
      ],
      0,
      WINDOW_END,
    );
    expect(d.storyCount).toBe(2);
  });

  it("folds the per-channel copies of a fanned-out story into one tile", () => {
    const d = buildDigestModel(
      [
        row({ story_key: "C_TEALS|deadbeef|1757310000000", channel: "C_TEALS" }),
        row({ story_key: "C_VIC|deadbeef|1757310000001", channel: "C_VIC" }),
        row({ story_key: "C_ALL|deadbeef|1757310000002", channel: "C_ALL" }),
      ],
      0,
      WINDOW_END,
    );
    expect(d.storyCount).toBe(1);
    // ...and the section total must count its reach ONCE, not three times.
    expect(d.sections[0]!.totalReach).toBe(5_000_000);
  });

  it("still treats genuinely different stories in one channel as separate tiles", () => {
    const d = buildDigestModel(
      [row({ story_key: "C_ALL|aaa" }), row({ story_key: "C_ALL|bbb" })],
      0,
      WINDOW_END,
    );
    expect(d.storyCount).toBe(2);
  });

  it("picks the same winning copy regardless of the order D1 returns rows", () => {
    const a = row({ story_key: "C_A|dup", created_at: 5_000 });
    const b = row({ story_key: "C_B|dup", created_at: 7_000 });
    const forward = buildDigestModel([a, b], 0, WINDOW_END);
    const reverse = buildDigestModel([b, a], 0, WINDOW_END);
    expect(forward.sections[0]!.tiles[0]!.storyKey).toBe("C_A|dup"); // oldest copy wins on a reach tie
    expect(reverse.sections[0]!.tiles[0]!.storyKey).toBe("C_A|dup");
  });

  it("skips an unparseable row rather than failing the whole digest", () => {
    const bad = row({ story_key: "bad", primary_mention_json: "{not json" });
    const good = row({ story_key: "good" });
    expect(buildDigestModel([bad, good], 0, WINDOW_END).storyCount).toBe(1);
  });

  it("falls back to the default brief colour for an unknown label", () => {
    expect(colorForBriefLabel("Media Monitoring")).toBe("#868e96");
    expect(colorForBriefLabel("climate 200")).toBe("#f76707"); // case-insensitive
  });

  it("sums combined reach across outlets, ignoring null/negative", () => {
    expect(combinedReach([{ name: "a", url: null, reach: 513000 }, { name: "b", url: null, reach: null }, { name: "c", url: null, reach: 250000 }])).toBe(763_000);
  });
});

// A StoryRow with sensible defaults; override per-test via `over`.
function row(over: Partial<StoryRow> = {}): StoryRow {
  return {
    story_key: "k",
    slack_ts: "1.0",
    channel: "C1",
    brief_label: "Climate 200",
    primary_mention_json: JSON.stringify({
      url: "https://x.example/a",
      outletUrl: null,
      title: "Something happened",
      sourceName: "The Age",
      mediaType: "online_news",
      countryCode: "AU",
      reach: 5000000,
      sentiment: "neutral",
      publishedAt: "2026-06-11T06:02:00+10:00",
      snippet: "A snippet mentioning Climate 200 today.",
      author: "Rob Harris",
      briefName: "Climate 200",
      imageUrl: null,
      matchedKeywords: ["Climate 200"],
      raw: null,
    }),
    outlets_json: '[{"name":"The Age","url":"https://x.example/a","reach":5000000}]',
    brief_labels_json: '["Climate 200"]',
    simhash: null,
    media_type: "online_news",
    render_hash: null,
    created_at: 5_000,
    updated_at: 5_000,
    ...over,
  };
}
