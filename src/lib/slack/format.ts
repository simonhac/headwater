import type { NormalizedMention } from "@/lib/meltwater/types";
import type { BriefRule } from "@/config/feed.config";
import { keywordsFor } from "@/lib/filter/engine";
import { sourceIcon } from "./icons";
import {
  escapeMrkdwn,
  highlightKeywordsAsCode,
  buildMentionsLine,
  truncate,
  hasAnyKeyword,
} from "./highlight";

export interface SlackPostPayload {
  channel: string;
  text: string;
  blocks: unknown[];
  unfurl_links: false;
  unfurl_media: false;
}

// Display timestamps in the feed's local timezone (configurable if needed).
const DATE_FMT = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Australia/Sydney",
});

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return DATE_FMT.format(d).replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());
}

/**
 * Build the Streem-style Block Kit blocks for one mention.
 * `otherOutlets` are additional outlets that carried the same (syndicated) story;
 * when present, a "📡 Also in: …" line is appended.
 */
export function buildBlocks(m: NormalizedMention, brief: BriefRule, otherOutlets: string[] = []): unknown[] {
  const kws = keywordsFor(m, brief);
  const blocks: unknown[] = [];

  // 1) context: source icon + bold source name (· media type · date)
  const metaBits = [`*${escapeMrkdwn(m.sourceName ?? "Unknown source")}*`];
  if (m.mediaType) metaBits.push(escapeMrkdwn(m.mediaType));
  const date = fmtDate(m.publishedAt);
  if (date) metaBits.push(date);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${sourceIcon(m.sourceName, m.countryCode)} ${metaBits.join("  ·  ")}` }],
  });

  // 2) bold blue clickable headline
  const title = m.title ?? m.url ?? "(untitled)";
  const headline = m.url
    ? `*<${m.url}|${escapeMrkdwn(title)}>*`
    : `*${escapeMrkdwn(title)}*`;
  blocks.push({ type: "section", text: { type: "mrkdwn", text: headline } });

  // 3) body: snippet-with-pills if the snippet contains a keyword, else a "Mentions:" line
  const fullText = `${m.title ?? ""} ${m.snippet ?? ""}`.trim();
  let body: string | null = null;
  if (m.snippet && kws.length && hasAnyKeyword(m.snippet, kws)) {
    body = highlightKeywordsAsCode(truncate(m.snippet), kws);
  } else {
    body = buildMentionsLine(fullText, kws) ?? (m.snippet ? escapeMrkdwn(truncate(m.snippet)) : null);
  }
  if (body) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });

  // 4) two-column footer: Author | Organisation Brief
  const fields: { type: "mrkdwn"; text: string }[] = [];
  if (m.author) fields.push({ type: "mrkdwn", text: `*Author*\n${escapeMrkdwn(m.author)}` });
  fields.push({ type: "mrkdwn", text: `*Organisation Brief*\n${escapeMrkdwn(brief.label)}` });
  blocks.push({ type: "section", fields });

  // 5) syndication: list the other outlets that ran the same story
  if (otherOutlets.length) {
    const shown = otherOutlets.slice(0, 8).map(escapeMrkdwn).join("  ·  ");
    const more = otherOutlets.length > 8 ? `  +${otherOutlets.length - 8} more` : "";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `📡 Also in: ${shown}${more}` }],
    });
  }

  return blocks;
}

export function buildPostPayload(m: NormalizedMention, brief: BriefRule, channel: string): SlackPostPayload {
  const fallback = `${m.sourceName ?? "News"}: ${m.title ?? m.url ?? ""}`.trim();
  return {
    channel,
    text: fallback,
    blocks: buildBlocks(m, brief),
    unfurl_links: false,
    unfurl_media: false,
  };
}
