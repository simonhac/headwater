import type { NormalizedMention } from "@/lib/meltwater/types";
import type { BriefRule, FeedConfig } from "@/config/feed.config";

export interface KeptItem {
  mention: NormalizedMention;
  brief: BriefRule;
}
export interface DroppedItem {
  mention: NormalizedMention;
  reason: string;
}
export interface FilterResult {
  kept: KeptItem[];
  dropped: DroppedItem[];
}

const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
const includesAny = (hay: string, needles: string[]) => needles.some((n) => hay.includes(n.toLowerCase()));

export function resolveBrief(m: NormalizedMention, cfg: FeedConfig): BriefRule {
  const name = lc(m.briefName);
  if (name) {
    const byName = cfg.briefs.find((b) => (b.matchNames ?? []).some((n) => name.includes(n.toLowerCase())));
    if (byName) return byName;
  }
  const text = `${lc(m.title)} ${lc(m.snippet)}`;
  const byKeyword = cfg.briefs.find((b) => b.keywords.some((k) => text.includes(k.toLowerCase())));
  if (byKeyword) return byKeyword;
  return { id: "default", label: cfg.defaultBriefLabel, keywords: [] };
}

/** Keywords we'll highlight for a mention: payload-provided ∪ the brief's configured keywords. */
export function keywordsFor(m: NormalizedMention, brief: BriefRule): string[] {
  const set = new Map<string, string>(); // lowercased -> original casing
  for (const k of [...m.matchedKeywords, ...brief.keywords]) {
    const key = k.toLowerCase();
    if (key && !set.has(key)) set.set(key, k);
  }
  return [...set.values()];
}

/** Pure filter: returns which mentions to post (with their brief) and which were dropped and why. */
export function applyFilters(mentions: NormalizedMention[], cfg: FeedConfig): FilterResult {
  const kept: KeptItem[] = [];
  const dropped: DroppedItem[] = [];

  for (const m of mentions) {
    const mediaType = lc(m.mediaType);
    if (cfg.excludeMediaTypes.length && includesAny(mediaType, cfg.excludeMediaTypes)) {
      dropped.push({ mention: m, reason: `media_type_excluded (${m.mediaType})` });
      continue;
    }
    if (cfg.includeMediaTypes && !(mediaType && includesAny(mediaType, cfg.includeMediaTypes))) {
      dropped.push({ mention: m, reason: `media_type_not_included (${m.mediaType})` });
      continue;
    }
    if (cfg.allowedCountryCodes && !cfg.allowedCountryCodes.map(lc).includes(lc(m.countryCode))) {
      dropped.push({ mention: m, reason: `country_excluded (${m.countryCode})` });
      continue;
    }
    const source = lc(m.sourceName);
    if (cfg.sourceBlocklist.length && includesAny(source, cfg.sourceBlocklist)) {
      dropped.push({ mention: m, reason: `source_blocked (${m.sourceName})` });
      continue;
    }
    if (cfg.sourceAllowlist && !(source && includesAny(source, cfg.sourceAllowlist))) {
      dropped.push({ mention: m, reason: `source_not_allowlisted (${m.sourceName})` });
      continue;
    }
    if (cfg.minSourceReach > 0 && m.reach !== null && m.reach < cfg.minSourceReach) {
      dropped.push({ mention: m, reason: `reach_below_min (${m.reach} < ${cfg.minSourceReach})` });
      continue;
    }

    const brief = resolveBrief(m, cfg);
    const kws = keywordsFor(m, brief);
    const text = `${lc(m.title)} ${lc(m.snippet)}`;
    const hasKeyword = m.matchedKeywords.length > 0 || kws.some((k) => text.includes(k.toLowerCase()));

    if (cfg.requireMatchedKeyword && !hasKeyword) {
      dropped.push({ mention: m, reason: "no_matched_keyword" });
      continue;
    }
    if (brief.requireKeyword && !hasKeyword) {
      dropped.push({ mention: m, reason: `brief_keyword_required (${brief.label})` });
      continue;
    }

    kept.push({ mention: m, brief });
  }

  return { kept, dropped };
}
