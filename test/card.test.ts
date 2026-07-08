import { describe, it, expect } from "vitest";
import type { SlackAttachment } from "@/lib/slack/format";
import { escHtml, mrkdwnText, safeUrl, renderCardBody, decisionPill } from "@/ui/card";

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
    author_name: "The Australian",
    title: "Big renewable news",
    title_link: "https://x.example/a",
    text: "The `renewable` rollout and `Ross Garnaut`.",
    fields: [
      { title: "Author", value: "Judith Sloan", short: true },
      { title: "Organisation Brief", value: "Key People", short: true },
    ],
    footer: "Wed, 8 Jul 2026, 8:30am AEST  ·  news  ·  😐  ·  480K reach",
    mrkdwn_in: ["text", "fields"],
  };

  it("renders masthead, headline link, keyword pills, both fields and footer", () => {
    const html = renderCardBody(att);
    expect(html).toContain('<span class="att-masthead">The Australian</span>');
    expect(html).toContain('<a class="att-title sr-link" href="https://x.example/a"');
    expect(html).toContain('<code class="sr-inline-code">renewable</code>');
    expect(html).toContain('<div class="att-field-label">Author</div>');
    expect(html).toContain('<div class="att-field-label">Organisation Brief</div>');
    expect(html).toContain("480K reach");
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it("renders a plain (non-link) headline when title_link is missing/unsafe", () => {
    const html = renderCardBody({ ...att, title_link: "javascript:alert(1)" });
    expect(html).toContain('<div class="att-title att-title--plain">Big renewable news</div>');
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
