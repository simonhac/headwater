import type { NormalizedMention } from "./types";

/**
 * DEFENSIVE parser. Meltwater's Generic Webhook payload schema is undocumented,
 * so we (a) find the array of documents under any of several likely keys, and
 * (b) extract each field by trying many candidate key names / nested paths.
 * When we capture a real payload via /inspect, we tighten the candidate lists.
 */

type Json = unknown;

function asRecord(v: Json): Record<string, Json> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : null;
}

/** Resolve a dot-path ("source.name") or plain key against an object. */
function getPath(obj: Record<string, Json>, path: string): Json {
  if (path in obj) return obj[path];
  let cur: Json = obj;
  for (const part of path.split(".")) {
    const rec = asRecord(cur);
    if (!rec || !(part in rec)) return undefined;
    cur = rec[part];
  }
  return cur;
}

/** First non-empty value across candidate paths. */
function pick(obj: Record<string, Json>, paths: string[]): Json {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function str(v: Json): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const rec = asRecord(v);
  if (rec) {
    // common nested shapes: { name: "..." } / { value: "..." } / { label: "..." }
    for (const k of ["name", "value", "label", "text", "title"]) {
      if (typeof rec[k] === "string") return (rec[k] as string).trim() || null;
    }
  }
  return null;
}

function num(v: Json): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isoDate(v: Json): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function keywords(v: Json): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => str(x)).filter((x): x is string => !!x);
  }
  const s = str(v);
  if (!s) return [];
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const KEYS = {
  url: ["url", "document_url", "link", "permalink", "href", "article_url"],
  title: ["title", "document_title", "headline", "name"],
  sourceName: ["source_name", "source.name", "source", "publisher", "outlet", "media_outlet", "sourceName", "site_name"],
  mediaType: ["source_information_type", "information_type", "media_type", "content_type", "type", "mediaType"],
  countryCode: ["source_country_code", "country_code", "source.country_code", "country", "countryCode"],
  reach: ["source_reach", "reach", "source.reach", "audience", "circulation", "sourceReach"],
  sentiment: ["document_sentiment", "sentiment", "sentimentLabel", "sentiment.label"],
  publishedAt: ["document_publish_date", "published_date", "published_at", "pub_date", "date", "publishDate", "publishedAt"],
  snippet: [
    "document_hit_sentence", "hit_sentence", "document_opening_text", "opening_text",
    "summary", "description", "snippet", "excerpt", "body", "content", "text",
  ],
  author: ["document_author", "author", "byline", "author_name", "authorName", "document_author.name", "author.name"],
  briefName: ["input_name", "search_name", "saved_search_name", "alert_name", "brief", "searchName", "alertName", "search", "keyword"],
  imageUrl: ["document_image_link", "image", "image_url", "thumbnail", "imageUrl", "media_url"],
  matchedKeywords: ["document_matched_keywords", "matched_keywords", "keywords", "matchedKeywords", "hit_keywords"],
} as const;

function toMention(doc: Record<string, Json>, topBrief: string | null): NormalizedMention {
  return {
    url: str(pick(doc, [...KEYS.url])),
    title: str(pick(doc, [...KEYS.title])),
    sourceName: str(pick(doc, [...KEYS.sourceName])),
    mediaType: str(pick(doc, [...KEYS.mediaType])),
    countryCode: str(pick(doc, [...KEYS.countryCode])),
    reach: num(pick(doc, [...KEYS.reach])),
    sentiment: str(pick(doc, [...KEYS.sentiment])),
    publishedAt: isoDate(pick(doc, [...KEYS.publishedAt])),
    snippet: str(pick(doc, [...KEYS.snippet])),
    author: str(pick(doc, [...KEYS.author])),
    briefName: str(pick(doc, [...KEYS.briefName])) ?? topBrief,
    imageUrl: str(pick(doc, [...KEYS.imageUrl])),
    matchedKeywords: keywords(pick(doc, [...KEYS.matchedKeywords])),
    raw: doc,
  };
}

/** Find the array of documents inside an arbitrary payload. */
function findDocuments(payload: Json): { docs: Record<string, Json>[]; topBrief: string | null } {
  const root = asRecord(payload);
  const topBrief = root ? str(pick(root, [...KEYS.briefName])) : null;

  if (Array.isArray(payload)) {
    return { docs: payload.map(asRecord).filter((r): r is Record<string, Json> => !!r), topBrief };
  }
  if (root) {
    for (const key of ["documents", "results", "mentions", "items", "data", "hits", "articles", "alerts"]) {
      const v = root[key];
      if (Array.isArray(v)) {
        return { docs: v.map(asRecord).filter((r): r is Record<string, Json> => !!r), topBrief };
      }
    }
    // Single-document payload: treat the object itself as one mention.
    return { docs: [root], topBrief };
  }
  return { docs: [], topBrief };
}

export function parseWebhookPayload(payload: Json): NormalizedMention[] {
  const { docs, topBrief } = findDocuments(payload);
  return docs.map((d) => toMention(d, topBrief));
}
