import type { NormalizedMention } from "@/lib/meltwater/types";
import type { Outlet } from "@/lib/story";
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

// `timePrefix` marks an approximate time (a "~" for the webhook-receipt fallback); "" otherwise.
function assemble(p: Record<string, string>, abbr: string, timePrefix = ""): string {
  const period = (p.dayPeriod ?? "").toLowerCase().replace(/\s/g, "");
  // en-AU renders some short months in full (e.g. "July"); slice normalises every month to 3 letters.
  const month = (p.month ?? "").slice(0, 3);
  return `${p.weekday}, ${p.day} ${month} ${p.year}, ${timePrefix}${p.hour}:${p.minute}${period} ${abbr}`;
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

/**
 * Last-resort date for the footer: the webhook-receipt instant (epoch ms) rendered in the feed's
 * home timezone and marked approximate with a "~" before the time — e.g. "Wed, 8 Jul 2026, ~7:40am
 * AEST". Used only when the payload carries no publish date (Meltwater's "Every Mention" shape omits
 * it) and the title has no broadcast air-time; the "~" flags that this is the receipt time, not the
 * story's own timestamp. Null for a missing/invalid instant.
 */
export function fmtReceivedApprox(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const p = partsOf(HOME_FMT, new Date(ms));
  return assemble(p, p.timeZoneName ?? "", "~");
}

/** Compact number, e.g. 480000 → "480K", 2500000 → "2.5M", 5860 → "5.9K" (null when absent/zero). */
export function compactReach(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

/** Compact reach with suffix, e.g. 480000 → "480K reach" (null when absent/zero). */
export function fmtReach(n: number | null): string | null {
  const c = compactReach(n);
  return c && `${c} reach`;
}

/** Thumbs marker for a mention's sentiment; null when unknown. */
function sentimentEmoji(sentiment: string | null): string | null {
  switch (sentiment) {
    case "positive": return "👍";
    case "negative": return "👎";
    case "neutral": return "😐";
    default: return null;
  }
}

// Broadcast titles arrive as "<program> - Wed, 08 Jul 2026 08:30:58 +1000"; capture the RFC tail.
const BROADCAST_TAIL = /\s+-\s+(\w{3},\s*\d{1,2}\s+\w{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[+-]\d{4})\s*$/;

/** The raw air-date tail of a broadcast title ("Wed, 08 Jul 2026 08:30:58 +1000"), or null. */
export function broadcastAirtime(title: string | null): string | null {
  if (!title) return null;
  const m = BROADCAST_TAIL.exec(title);
  return m ? m[1]! : null;
}

/** Strip a broadcast title's trailing air date/time, leaving just the program name (its time moves
 * to the footer). Non-broadcast titles pass through unchanged. */
export function cleanTitle(title: string | null): string | null {
  if (!title) return title;
  const m = BROADCAST_TAIL.exec(title);
  return m ? title.slice(0, m.index).trimEnd() : title;
}

/** Left-bar colour for a brief (its own colour, else the shared default). */
export function briefColor(brief: BriefRule): string {
  return brief.color ?? DEFAULT_BRIEF_COLOR;
}

/**
 * Build the Streem-style classic attachment for one mention. `otherOutlets` are additional outlets
 * that carried the same (syndicated) story; `otherBriefLabels` are the non-primary Organisation
 * Briefs that also matched it — both appended to the footer. `receivedAtMs` is the webhook-receipt
 * instant, used only as an approximate ("~") footer date when the mention has no better timestamp.
 */
export function buildAttachment(
  m: NormalizedMention,
  brief: BriefRule,
  otherOutlets: Outlet[] = [],
  otherBriefLabels: string[] = [],
  receivedAtMs: number | null = null,
): SlackAttachment {
  const kws = keywordsFor(m, brief);
  const masthead = m.sourceName ?? "Unknown source";
  const title = cleanTitle(m.title) ?? m.url ?? "(untitled)";

  // body: when there's a snippet, always show it (keywords highlighted as pills) and, if any tracked
  // keyword is mentioned in the item but NOT visible in the shown snippet, append an
  // "(also mentions `kw` …)" suffix. With no snippet, fall back to the "Mentions: kw (n)" summary.
  const fullText = `${m.title ?? ""} ${m.snippet ?? ""}`.trim();
  let text: string | undefined;
  if (m.snippet) {
    const shown = truncate(m.snippet);
    const body = highlightKeywordsAsCode(shown, kws); // escapes + pills; plain-escaped when kws empty
    const alsoMentions = kws.filter((k) => !hasAnyKeyword(shown, [k]) && hasAnyKeyword(fullText, [k]));
    const suffix = alsoMentions.length
      ? ` (also mentions ${alsoMentions.map((k) => "`" + escapeMrkdwn(k) + "`").join(" ")})`
      : "";
    text = body + suffix;
  } else {
    text = buildMentionsLine(fullText, kws) ?? undefined;
  }

  // Author | Organisation Brief columns
  const fields: { title: string; value: string; short: boolean }[] = [];
  if (m.author) fields.push({ title: "Author", value: escapeMrkdwn(m.author), short: true });
  fields.push({ title: "Organisation Brief", value: escapeMrkdwn(brief.label), short: true });

  // footer: date · media type · sentiment · reach (+ "also matched …" and "Also in: …"). Plain
  // text — Slack attachment footers don't render mrkdwn, so no pills here. When the story was
  // carried by multiple outlets, the single reach is replaced by the outlet count + summed reach.
  let reachBit: string | null;
  if (otherOutlets.length) {
    const count = otherOutlets.length + 1; // + the primary (headlined) outlet
    const total = [m.reach, ...otherOutlets.map((o) => o.reach)]
      .filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r > 0)
      .reduce((a, b) => a + b, 0);
    const combined = compactReach(total);
    reachBit = combined ? `${count} outlets with ${combined} combined reach` : `${count} outlets`;
  } else {
    reachBit = fmtReach(m.reach);
  }

  // Footer date, best available: the mention's own publish date → a broadcast title's air-time →
  // the webhook-receipt time (marked "~" as an approximate, secondary source).
  const footerDate =
    fmtFriendly(m.publishedAt) ??
    fmtFriendly(broadcastAirtime(m.title)) ??
    fmtReceivedApprox(receivedAtMs);

  const footerBits = [
    footerDate,
    m.mediaType,
    sentimentEmoji(m.sentiment),
    reachBit,
  ].filter((x): x is string => !!x);
  if (otherBriefLabels.length) footerBits.push(`also matched ${otherBriefLabels.join(", ")}`);
  if (otherOutlets.length) {
    const names = otherOutlets.map((o) => o.name);
    const shown = names.slice(0, 8).join(" · ");
    const more = names.length > 8 ? ` +${names.length - 8} more` : "";
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

export function buildPostPayload(
  m: NormalizedMention,
  brief: BriefRule,
  channel: string,
  receivedAtMs: number | null = null,
): SlackPostPayload {
  return {
    channel,
    attachments: [buildAttachment(m, brief, [], [], receivedAtMs)],
    unfurl_links: false,
    unfurl_media: false,
  };
}
