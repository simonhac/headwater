import { describe, it, expect } from "vitest";
import type { SlackAttachment } from "@/lib/slack/format";
import { escHtml, mrkdwnText, safeUrl, renderCardBody, decisionPill } from "@/ui/card";
import { ICON_BASE_URL } from "@/lib/slack/icons";

describe("escHtml", () => {
  it("entity-encodes &, <, >, \"", () => {
    expect(escHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
  it("neutralizes a raw XSS payload (e.g. an author_name / title)", () => {
    expect(escHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });
});

describe("mrkdwnText", () => {
  it("turns a backtick code span into a Slack-style keyword pill", () => {
    expect(mrkdwnText("Independent `MP` `Monique Ryan`, who…")).toBe(
      'Independent <code class="sr-inline-code">MP</code> <code class="sr-inline-code">Monique Ryan</code>, who…',
    );
  });
  it("does NOT re-escape already-escaped entities (no double-encode)", () => {
    // Input arrives already &<>-escaped by escapeMrkdwn; must be left intact.
    const input = "A quiet day with &lt; no &gt; keywords &amp; more.";
    expect(mrkdwnText(input)).toBe(input);
    expect(mrkdwnText(input)).not.toContain("&amp;lt;");
  });
  it("is idempotent on output containing no backticks", () => {
    const once = mrkdwnText("`teal (1)`");
    expect(mrkdwnText(once)).toBe(once);
  });
  it("leaves a lone stray backtick literal", () => {
    expect(mrkdwnText("a ` b")).toBe("a ` b");
  });
  it("renders a Slack <url|label> link as an anchor (the ↗ go-direct link)", () => {
    expect(mrkdwnText("Body. <https://abc.net.au/x?a=1&amp;b=2|↗>")).toBe(
      'Body. <a class="sr-link" href="https://abc.net.au/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">↗</a>',
    );
  });
  it("does not linkify a non-http(s) target", () => {
    expect(mrkdwnText("<javascript:alert(1)|x>")).toBe("<javascript:alert(1)|x>");
  });
});

describe("safeUrl", () => {
  it("accepts http(s) URLs (escaped)", () => {
    expect(safeUrl("https://x.example/a?b=1&c=2")).toBe("https://x.example/a?b=1&amp;c=2");
    expect(safeUrl("http://x.example")).toBe("http://x.example");
  });
  it("rejects javascript:, data:, and relative/empty URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>")).toBeNull();
    expect(safeUrl("/relative/path")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe("renderCardBody", () => {
  const att: SlackAttachment = {
    color: "#4263eb",
    fallback: "The Australian: Big renewable news",
    author_icon: "https://www.google.com/s2/favicons?sz=64&domain=theaustralian.com.au",
    author_name: "The Australian — Judith Sloan",
    title: "Big renewable news",
    title_link: "https://x.example/a",
    text: "The `renewable` rollout and `Ross Garnaut`.",
    footer: "Wed, 8 Jul 2026, 8:30am AEST  ·  Brief: Key People 😐  ·  480K reach",
    footer_icon: `${ICON_BASE_URL}/icons/media/v1/newspaper.png`,
    mrkdwn_in: ["text"],
  };

  it("renders masthead+byline, headline link, keyword pills, footer icon and footer", () => {
    const html = renderCardBody(att);
    expect(html).toContain('<span class="att-masthead">The Australian — Judith Sloan</span>');
    expect(html).toContain('<a class="att-title sr-link" href="https://x.example/a"');
    expect(html).toContain('<code class="sr-inline-code">renewable</code>');
    expect(html).toContain(
      `<img class="att-footer-icon" src="${ICON_BASE_URL}/icons/media/v1/newspaper.png"`,
    );
    expect(html).toContain("Brief: Key People");
    expect(html).toContain("480K reach");
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("att-field-label"); // the two-column fields row is gone
  });

  it("renders a plain (non-link) headline when title_link is missing/unsafe", () => {
    const html = renderCardBody({ ...att, title_link: "javascript:alert(1)" });
    expect(html).toContain('<div class="att-title att-title--plain">Big renewable news</div>');
    expect(html).not.toContain("javascript:");
  });

  it("hyperlinks the masthead when author_link is set (collapsed broadcast card)", () => {
    // No separate title line; the station heading itself is the link.
    const html = renderCardBody({
      color: "#868e96",
      fallback: "Triple M Gippsland 94.3 & 97.9",
      author_icon: "https://www.google.com/s2/favicons?sz=64&domain=mlt.example",
      author_name: "Triple M Gippsland 94.3 & 97.9",
      author_link: "https://mlt.example/track",
      mrkdwn_in: [],
    });
    expect(html).toContain('<a class="att-masthead sr-link" href="https://mlt.example/track"');
    expect(html).toContain("Triple M Gippsland 94.3 &amp; 97.9</a>");
    expect(html).not.toContain('class="att-title'); // the duplicate title line is gone
  });

  it("keeps the masthead a plain span when author_link is unsafe", () => {
    const html = renderCardBody({ ...att, author_link: "javascript:alert(1)", title: undefined, title_link: undefined });
    expect(html).toContain('<span class="att-masthead">The Australian — Judith Sloan</span>');
    expect(html).not.toContain("javascript:");
  });

  it("omits logo, text, fields and footer when absent", () => {
    const html = renderCardBody({
      color: "#868e96",
      fallback: "x",
      author_name: "📻 6PR 882 News Talk",
      title: "Drive with Jamie Burnett",
      mrkdwn_in: [],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("att-text");
    expect(html).not.toContain("sr-section-fields");
    expect(html).not.toContain("att-footer");
    expect(html).toContain("📻 6PR 882 News Talk");
  });
});

describe("decisionPill", () => {
  it("colors known decisions and escapes the label", () => {
    expect(decisionPill("posted")).toBe('<span class="deco-pill" style="background:#16794e">posted</span>');
    expect(decisionPill("dropped")).toContain("#8a1f1f");
  });
});
