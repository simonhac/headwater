import type { NormalizedMention } from "@/lib/meltwater/types";
import { type BriefRule, DEFAULT_BRIEF_COLOR } from "@/config/feed.config";
import { keywordsFor } from "@/lib/filter/engine";
import { sourceLogoUrl, mediaTypeEmoji } from "./icons";
import {
  escapeMrkdwn,
  highlightKeywordsAsCode,
  buildMentionsLine,
  truncate,
  hasAnyKeyword,
} from "./highlight";

/**
 * A Streem-style card, built as a CLASSIC (legacy-field) Slack attachment — not blocks-in-attachment.
 * Classic fields map 1:1 onto Streem's layout: author_icon+author_name = logo+masthead,
 * title+title_link = the headline link, text = the excerpt (with keyword pills), fields = the
 * Author | Organisation Brief columns, footer = the meta line, color = the left bar.
 */
export interface SlackAttachment {
  color: string;
  /** Notification / no-attachment-support fallback (replaces the top-level `text`). */
  fallback: string;
  author_name?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: { title: string; value: string; short: boolean }[];
  footer?: string;
  mrkdwn_in: string[];
}

export interface SlackPostPayload {
  channel: string;
  // No top-level `text` — it renders a plain line above the card (the attachment `fallback` covers notifications).
  attachments: SlackAttachment[];
  unfurl_links: false;
  unfurl_media: false;
}

const DATE_PARTS = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true } as const;
// Render the wall-clock time in the source's own offset (read UTC parts off a shifted date).
const UTC_FMT = new Intl.DateTimeFormat("en-AU", { ...DATE_PARTS, timeZone: "UTC" });
// Fallback only for timestamps that carry no offset — display in the feed's home timezone.
const HOME_FMT = new Intl.DateTimeFormat("en-AU", { ...DATE_PARTS, timeZone: "Australia/Sydney", timeZoneName: "short" });

// UTC offset (minutes) → Australian abbreviation; anything else falls back to a "UTC±H" label.
const OFFSET_ABBR: Record<number, string> = { 0: "UTC", 480: "AWST", 525: "ACWST", 570: "ACST", 600: "AEST", 630: "ACDT", 660: "AEDT" };

function offsetAbbrev(offMin: number): string {
  if (OFFSET_ABBR[offMin]) return OFFSET_ABBR[offMin]!;
  const a = Math.abs(offMin);
  const mm = a % 60;
  return `UTC${offMin < 0 ? "-" : "+"}${Math.floor(a / 60)}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

/** Minutes east of UTC parsed from a trailing "+10:00" / "+1000" / "Z"; null if none present. */
function parseOffsetMinutes(input: string): number | null {
  const s = input.trim();
  if (/[zZ]$/.test(s)) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function assemble(p: Record<string, string>, abbr: string): string {
  const period = (p.dayPeriod ?? "").toLowerCase().replace(/\s/g, "");
  // en-AU renders some short months in full (e.g. "July"); slice normalises every month to 3 letters.
  const month = (p.month ?? "").slice(0, 3);
  return `${p.weekday}, ${p.day} ${month} ${p.year}, ${p.hour}:${p.minute}${period} ${abbr}`;
}

function partsOf(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return p;
}

/**
 * Format an ISO/RFC date as e.g. "Wed, 8 Jul 2026, 8:30am AEST" — using the timestamp's OWN
 * offset for both the time and the abbreviation (+08:00 → AWST, +11:00 → AEDT, …). Null if
 * unparseable. Timestamps without an offset fall back to the feed's home timezone.
 */
export function fmtFriendly(input: string | null): string | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const offMin = parseOffsetMinutes(input);
  if (offMin === null) {
    const p = partsOf(HOME_FMT, d);
    return assemble(p, p.timeZoneName ?? "");
  }
  const shifted = new Date(d.getTime() + offMin * 60_000);
  return assemble(partsOf(UTC_FMT, shifted), offsetAbbrev(offMin));
}

/** Compact reach, e.g. 480000 → "480K reach", 5860 → "5.9K reach" (null when absent/zero). */
export function fmtReach(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  let s: string;
  if (n >= 1_000_000) s = (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  else if (n >= 1_000) s = (n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  else s = String(n);
  return `${s} reach`;
}

// Broadcast titles arrive as "<program> - Wed, 08 Jul 2026 08:30:58 +1000"; capture the RFC tail.
const BROADCAST_TAIL = /\s+-\s+(\w{3},\s*\d{1,2}\s+\w{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[+-]\d{4})\s*$/;

/** Lightly clean a broadcast title: keep the program name, reformat a trailing air date/time. */
export function cleanTitle(title: string | null): string | null {
  if (!title) return title;
  const m = BROADCAST_TAIL.exec(title);
  if (!m) return title;
  const friendly = fmtFriendly(m[1]!);
  if (!friendly) return title;
  return title.slice(0, m.index).trimEnd() + " - " + friendly;
}

/** Left-bar colour for a brief (its own colour, else the shared default). */
export function briefColor(brief: BriefRule): string {
  return brief.color ?? DEFAULT_BRIEF_COLOR;
}

/**
 * Build the Streem-style classic attachment for one mention. `otherOutlets` are additional outlets
 * that carried the same (syndicated) story; `otherBriefLabels` are the non-primary Organisation
 * Briefs that also matched it — both appended to the footer.
 */
export function buildAttachment(
  m: NormalizedMention,
  brief: BriefRule,
  otherOutlets: string[] = [],
  otherBriefLabels: string[] = [],
): SlackAttachment {
  const kws = keywordsFor(m, brief);
  const masthead = m.sourceName ?? "Unknown source";
  const title = cleanTitle(m.title) ?? m.url ?? "(untitled)";

  // body: snippet-with-pills if the snippet contains a keyword, else a "Mentions:" line
  const fullText = `${m.title ?? ""} ${m.snippet ?? ""}`.trim();
  let text: string | undefined;
  if (m.snippet && kws.length && hasAnyKeyword(m.snippet, kws)) {
    text = highlightKeywordsAsCode(truncate(m.snippet), kws);
  } else {
    text = buildMentionsLine(fullText, kws) ?? (m.snippet ? escapeMrkdwn(truncate(m.snippet)) : undefined);
  }

  // Author | Organisation Brief columns
  const fields: { title: string; value: string; short: boolean }[] = [];
  if (m.author) fields.push({ title: "Author", value: escapeMrkdwn(m.author), short: true });
  fields.push({ title: "Organisation Brief", value: escapeMrkdwn(brief.label), short: true });

  // footer: date · media type · reach (+ "also matched …" and "Also in: …"). Plain text — Slack
  // attachment footers don't render mrkdwn, so no pills here.
  const footerBits = [fmtFriendly(m.publishedAt), m.mediaType, fmtReach(m.reach)].filter(
    (x): x is string => !!x,
  );
  if (otherBriefLabels.length) footerBits.push(`also matched ${otherBriefLabels.join(", ")}`);
  if (otherOutlets.length) {
    const shown = otherOutlets.slice(0, 8).join(" · ");
    const more = otherOutlets.length > 8 ? ` +${otherOutlets.length - 8} more` : "";
    footerBits.push(`Also in: ${shown}${more}`);
  }

  const logo = sourceLogoUrl(m.sourceName, m.outletUrl ?? m.url);
  const att: SlackAttachment = {
    color: briefColor(brief),
    fallback: `${masthead}: ${title}`,
    author_name: logo ? masthead : `${mediaTypeEmoji(m.mediaType)} ${masthead}`,
    title,
    fields,
    mrkdwn_in: ["text", "fields"],
  };
  if (logo) att.author_icon = logo;
  if (m.url) att.title_link = m.url;
  if (text) att.text = text;
  if (footerBits.length) att.footer = footerBits.join("  ·  ");
  return att;
}

export function buildPostPayload(m: NormalizedMention, brief: BriefRule, channel: string): SlackPostPayload {
  return {
    channel,
    attachments: [buildAttachment(m, brief)],
    unfurl_links: false,
    unfurl_media: false,
  };
}
