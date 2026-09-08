import type { SlackAttachment } from "@/lib/slack/format";
import { escHtml, safeUrl } from "@/ui/card";
import type { Digest, DigestSection, DigestTile } from "@/lib/digest";

/*
 * Email rendering of the story card — the sibling of `renderCardBody` (src/ui/card.ts).
 *
 * Same SlackAttachment in, same strings out; only the markup differs. /inspect can use classes and
 * flexbox because it renders in a browser we control. Email cannot: Gmail and Outlook strip
 * <style> blocks, positioned pseudo-elements and CSS custom properties, so everything here is
 * nested <table>s with inline styles, and the card's left colour bar is a border-left on the inner
 * <td> rather than inspect.styles.ts's `.att-main::before`.
 *
 * Design reference: docs/newsletter/tile-mock.html (the static mock this was lifted from).
 *
 * Escaping follows card.ts exactly — see its header comment. `escHtml` for RAW strings
 * (author_name, title, footer, URLs); `emailMrkdwn` for `att.text`, which arrives ALREADY
 * &<>-escaped by escapeMrkdwn and must never be re-escaped.
 */

// --- tokens: the light-mode values of src/ui/inspect.styles.ts, inlined ---------------------------
const PAGE_BG = "#f8f8f8";
const SURFACE = "#ffffff";
const TEXT = "#1d1c1d";
const MUTED = "#616061";
const LINK = "#1264a3";
const HAIR = "rgba(29,28,29,0.13)";
const HAIR_SOFT = "rgba(29,28,29,0.08)";
const FONT = "15px/1.46668 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The keyword pill (`.sr-inline-code`), fully inlined — Outlook ignores `var(--…)`. */
const PILL_STYLE =
  "background:rgba(29,28,29,0.04); border:1px solid rgba(29,28,29,0.13); border-radius:3px;" +
  " padding:2px 3px 1px; font-size:12px; font-family:'Monaco','Menlo','Consolas',monospace;" +
  " color:rgb(192,19,67); line-height:18px;";

/**
 * Convert an ALREADY-&<>-escaped Slack mrkdwn fragment to email HTML. The email twin of
 * `mrkdwnText` (card.ts): identical transforms, but emitting inline styles instead of `.sr-*`
 * classes. Same XSS reasoning applies — only http(s) links match, and <code>/<a> are the only tags
 * introduced.
 */
export function emailMrkdwn(alreadyEscaped: string): string {
  return alreadyEscaped
    .replace(
      /<(https?:\/\/[^|>\s]+)\|([^>]*)>/g,
      (_m, url, label) =>
        `<a href="${url.replace(/"/g, "&quot;")}" style="color:${LINK}; text-decoration:none;">${label}</a>`,
    )
    .replace(/`([^`]+)`/g, `<code style="${PILL_STYLE}">$1</code>`);
}

/**
 * One story card as an email-safe table. Mirrors `renderCardBody`'s four rows — head, headline,
 * excerpt, footer — including the collapsed broadcast variant (no `title`: the masthead itself
 * becomes the link, via `author_link`).
 */
export function renderEmailTile(att: SlackAttachment): string {
  const bar = /^#[0-9a-f]{3,8}$/i.test(att.color) ? att.color : "#868e96";

  // Head: optional favicon + masthead (linked when the title collapsed into it).
  const logo = safeUrl(att.author_icon);
  const logoCell = logo
    ? `<td width="18" valign="middle" style="width:18px; padding-right:8px;">` +
      `<img src="${logo}" width="18" height="18" alt="" style="display:block; width:18px; height:18px; border:0; border-radius:3px;"></td>`
    : "";
  const mastheadHref = safeUrl(att.author_link);
  let head = "";
  if (att.author_name || logoCell) {
    const name = att.author_name ? escHtml(att.author_name) : "";
    const mastheadCell = mastheadHref
      ? `<td valign="middle"><a href="${mastheadHref}" style="font-size:15px; font-weight:700; color:${LINK}; text-decoration:none;">${name}</a></td>`
      : `<td valign="middle" style="font-size:15px; font-weight:700; color:${TEXT};">${name}</td>`;
    head =
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:3px;">` +
      `<tr>${logoCell}${mastheadCell}</tr></table>`;
  }

  // Headline.
  let title = "";
  if (att.title) {
    const href = safeUrl(att.title_link);
    const label = escHtml(att.title);
    title = href
      ? `<div style="margin:2px 0 4px 0;"><a href="${href}" style="font-size:15px; font-weight:700; color:${LINK}; text-decoration:none;">${label}</a></div>`
      : `<div style="margin:2px 0 4px 0; font-size:15px; font-weight:700; color:${TEXT};">${label}</div>`;
  }

  // Excerpt: pills + the trailing ↗ direct link.
  const text = att.text
    ? `<div style="font-size:15px; line-height:22px; color:${TEXT}; margin:2px 0 8px 0;">${emailMrkdwn(att.text)}</div>`
    : "";

  // Footer: medium glyph + the date · brief · reach line.
  let footer = "";
  if (att.footer) {
    const iconUrl = safeUrl(att.footer_icon);
    const iconCell = iconUrl
      ? `<td width="14" valign="top" style="width:14px; padding-right:6px;">` +
        `<img src="${iconUrl}" width="14" height="18" alt="" style="display:block; width:14px; height:18px; border:0;"></td>`
      : "";
    footer =
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">` +
      `<tr>${iconCell}<td valign="top" style="font-size:13px; line-height:18px; color:${MUTED};">${escHtml(att.footer)}</td></tr>` +
      `</table>`;
  }

  return (
    `<tr><td style="padding:6px 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE}; border:1px solid ${HAIR_SOFT};">` +
    `<tr><td style="border-left:4px solid ${bar}; padding:10px 14px 12px 14px;">` +
    head +
    title +
    text +
    footer +
    `</td></tr></table></td></tr>`
  );
}

/** Section header: brief-coloured swatch + label + muted counts, over a hairline. */
function renderSectionHeader(section: DigestSection, isFirst: boolean): string {
  const stories = `${section.tiles.length} ${section.tiles.length === 1 ? "story" : "stories"}`;
  const reach = section.totalReach > 0 ? `&nbsp;&middot;&nbsp;${compactReachText(section.totalReach)} combined reach` : "";
  return (
    `<tr><td style="padding:${isFirst ? "12px" : "18px"} 2px 0 2px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="10" valign="middle" style="width:10px; padding:0 8px 0 0;">` +
    `<div style="width:10px; height:10px; background:${section.color}; border-radius:2px; font-size:0; line-height:0;">&nbsp;</div></td>` +
    `<td valign="middle" style="font-size:13px; line-height:18px; color:${TEXT};">` +
    `<span style="font-weight:700; letter-spacing:0.4px;">${escHtml(section.label.toUpperCase())}</span>` +
    `<span style="color:${MUTED}; font-weight:400;">&nbsp;&middot;&nbsp;${stories}${reach}</span></td>` +
    `</tr></table>` +
    `<div style="height:1px; background:${HAIR}; font-size:0; line-height:0; margin:8px 0 6px 0;">&nbsp;</div>` +
    `</td></tr>`
  );
}

/**
 * Compact reach for the digest's own chrome (section totals). Deliberately duplicates
 * `compactReach`'s output format — that one is private to format.ts and operates on a mention.
 */
export function compactReachText(n: number): string {
  if (n >= 1_000_000) return `${stripZero((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${stripZero((n / 1_000).toFixed(n >= 100_000 ? 0 : 1))}K`;
  return String(n);
}
const stripZero = (s: string) => s.replace(/\.0$/, "");

/**
 * Date range for the header, in the digest's display timezone. Never throws: this runs inside the
 * send path, and an out-of-range timestamp must not cost the whole digest.
 */
function rangeLabel(sinceMs: number, untilMs: number, timeZone: string): string {
  const fmt = (ms: number) => {
    try {
      return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(ms));
    } catch {
      return "";
    }
  };
  const from = fmt(sinceMs);
  const to = fmt(untilMs - 1);
  if (!from || !to) return from || to;
  return from === to ? from : `${from} &ndash; ${to}`;
}

export interface DigestEmailOptions {
  /** Display timezone for the header range. */
  timeZone?: string;
  /** Link to the Slack channel, shown in the footer when set. */
  slackUrl?: string;
}

/** The full digest email: doctype, header, sections of tiles, footer. Self-contained and inline-styled. */
export function renderDigestEmail(digest: Digest, opts: DigestEmailOptions = {}): string {
  const timeZone = opts.timeZone ?? "Australia/Melbourne";
  const briefs = digest.sections.length;
  const subhead =
    `${rangeLabel(digest.sinceMs, digest.untilMs, timeZone)} &nbsp;&middot;&nbsp; ` +
    `${digest.storyCount} ${digest.storyCount === 1 ? "story" : "stories"} &nbsp;&middot;&nbsp; ` +
    `${briefs} ${briefs === 1 ? "brief" : "briefs"}`;

  const body = digest.sections
    .map((section, i) => renderSectionHeader(section, i === 0) + section.tiles.map((t: DigestTile) => renderEmailTile(t.att)).join(""))
    .join("");

  const slackLink = opts.slackUrl
    ? ` &nbsp;&middot;&nbsp; <a href="${escHtml(opts.slackUrl)}" style="color:${LINK}; text-decoration:none;">Open the Slack channel</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Headwater &mdash; media digest</title>
<style>
  /* Only rule in the document; everything else is inline. Inert in Outlook, which is fine. */
  @media only screen and (max-width: 660px) { .hw-shell { width: 100% !important; } }
</style>
</head>
<body style="margin:0; padding:0; background:${PAGE_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG}; margin:0; padding:0;">
<tr><td align="center" style="padding:24px 12px 40px 12px;">
<table role="presentation" class="hw-shell" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px; max-width:640px; font:${FONT}; color:${TEXT};">
  <tr><td style="padding:0 2px 14px 2px;">
    <div style="font-size:15px; font-weight:900; color:${TEXT}; letter-spacing:-0.1px;">Headwater &mdash; media digest</div>
    <div style="font-size:13px; line-height:18px; color:${MUTED}; margin-top:2px;">${subhead}</div>
  </td></tr>
${body}
  <tr><td style="padding:22px 2px 0 2px;">
    <div style="height:1px; background:${HAIR}; font-size:0; line-height:0; margin-bottom:10px;">&nbsp;</div>
    <div style="font-size:12px; line-height:18px; color:${MUTED};">Generated by Headwater from the Meltwater feed${slackLink}</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Plain-text alternative. Always send this alongside the HTML: some clients show only text, and a
 * missing text/plain part measurably worsens spam scoring.
 */
export function renderDigestText(digest: Digest, opts: DigestEmailOptions = {}): string {
  const timeZone = opts.timeZone ?? "Australia/Melbourne";
  const range = rangeLabel(digest.sinceMs, digest.untilMs, timeZone).replace("&ndash;", "-");
  const lines: string[] = [`Headwater - media digest`, `${range} · ${digest.storyCount} stories`, ""];

  for (const section of digest.sections) {
    lines.push(`## ${section.label.toUpperCase()} (${section.tiles.length})`, "");
    for (const { att } of section.tiles) {
      if (att.author_name) lines.push(att.author_name);
      if (att.title) lines.push(att.title);
      if (att.title_link ?? att.author_link) lines.push(String(att.title_link ?? att.author_link));
      if (att.footer) lines.push(att.footer);
      lines.push("");
    }
  }
  lines.push("Generated by Headwater from the Meltwater feed.");
  return lines.join("\n");
}
