import type { NormalizedMention } from "./types";
import { deriveOutletName, hostnameOf, mastheadForDomain, looksLikePerson } from "./outlets";

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

/**
 * Meltwater's "Every Mention" alert webhook is a FLAT object with very different semantics from
 * the structured `documents[]` shape — `source` is the brief (not the outlet), `type` is literally
 * "Every Mention", the outlet lives in `authorName`, the medium in `providerType`, reach + sentiment
 * are baked into `statusLine`, and the link is a Meltwater licensed/tracking redirect under `links`.
 * The generic candidate lists mis-read all of these, so this shape gets its own explicit mapping.
 */
function isEveryMention(doc: Record<string, Json>): boolean {
  return doc["type"] === "Every Mention" || ("providerType" in doc && "statusLine" in doc);
}

/** Map Meltwater medium codes to our simple set (e.g. "tveyes_radio" → "radio"). */
function normalizeMedium(v: Json): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^tveyes[_-](\w+)/i.exec(s);
  return (m ? m[1]! : s).toLowerCase();
}

/** Reach out of a status line like "🔊 1.59M Reach — 😔 Negative Sentiment". */
function reachFromStatusLine(v: Json): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /([\d.]+)\s*([kmb])?\s*reach/i.exec(s);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  const n = parseFloat(m[1]!) * mult;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function sentimentFromStatusLine(v: Json): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /\b(positive|neutral|negative)\b/i.exec(s);
  return m ? m[1]!.toLowerCase() : null;
}

/** Unwrap a Meltwater tracking redirect (…?u=<double-encoded real url>) to the underlying URL. */
function unwrapTrackingUrl(v: Json): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s).searchParams.get("u");
    return u ? decodeURIComponent(u) : s;
  } catch {
    return s;
  }
}

/** A Meltwater tracking/redirect host (not a real publisher), e.g. app.meltwater.com, transition.meltwater.com. */
function isTrackingHost(host: string): boolean {
  return host === "meltwater.com" || host.endsWith(".meltwater.com");
}

/** First URL whose host is a real publisher (skipping Meltwater's own tracking/redirect hosts); null if none. */
function firstPublisherUrl(urls: (string | null)[]): string | null {
  for (const u of urls) {
    const host = hostnameOf(u);
    if (host && !isTrackingHost(host)) return u;
  }
  return null;
}

/** Radio/TV — these carry their own station-resolution path in process.ts, so leave them to it. */
export function isBroadcastMedium(mediaType: string | null): boolean {
  const t = (mediaType ?? "").toLowerCase();
  return t === "radio" || t === "tv" || t === "television";
}

/**
 * Does `authorName` name the same entity as the publisher domain — i.e. it's the OUTLET, not a byline?
 * (e.g. "Bendigo Advertiser" ↔ bendigoadvertiser.com.au.) Compares alphanumerics of the name against
 * the domain's registrable label, ignoring case/punctuation. Used to avoid demoting an outlet-name to
 * the Author field for domains not in the masthead table. A journalist byline ("Jorge Branco") shares
 * no such overlap with its publisher's domain ("nine.com.au").
 */
function authorIsOutlet(author: string | null, host: string | null): boolean {
  const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = alnum(author ?? "");
  if (a.length < 3) return false;
  const core = alnum(deriveOutletName(host) ?? "");
  const full = alnum(host ?? "");
  return (!!core && (core.includes(a) || a.includes(core))) || full.includes(a);
}

/** Strip trailing Meltwater annotations from an outlet name, e.g. "(Print version) (Licensed by …)". */
function cleanOutletName(v: Json): string | null {
  let s = str(v);
  if (!s) return null;
  while (/\)\s*$/.test(s)) {
    const trimmed = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (trimmed === s) break;
    s = trimmed;
  }
  return s || null;
}

function everyMentionToMention(doc: Record<string, Json>, topBrief: string | null): NormalizedMention {
  const links = asRecord(doc["links"]) ?? {};
  const mediaType = normalizeMedium(doc["providerType"]);
  const sourceUrl = unwrapTrackingUrl(links["source"]); // publisher home (for the logo + masthead)
  const articleUrl = unwrapTrackingUrl(links["article"]); // real article URL, or a Meltwater redirect host
  const rawAuthor = cleanOutletName(doc["authorName"]);

  // `authorName` is the outlet for some content but a JOURNALIST byline for wire/agency/syndicated
  // content. The real publisher lives in the links: prefer `links.source` (the outlet home), fall back
  // to `links.article`, ignoring Meltwater's own tracking hosts. Whenever we can name the publisher
  // (a known masthead, else a name derived from its domain) that becomes the outlet and `authorName`
  // is demoted to the byline. Broadcast keeps its existing masthead-only lookup — process.ts resolves
  // the station name separately and shouldn't have a domain guessed underneath it.
  const publisherUrl = isBroadcastMedium(mediaType) ? sourceUrl : firstPublisherUrl([sourceUrl, articleUrl]);
  const publisherHost = hostnameOf(publisherUrl);
  let outlet: string | null;
  if (isBroadcastMedium(mediaType)) {
    outlet = mastheadForDomain(publisherHost); // process.ts refines this into the station name
  } else if (publisherHost) {
    // Known masthead → authorName is the byline. Otherwise recover the outlet from the domain ONLY when
    // authorName reads like a person; a masthead-like authorName (or one that already names the domain)
    // is kept as-is rather than mangled into a domain-derived name ("Chelsea Mordialloc Mentone News").
    const keepAuthor = authorIsOutlet(rawAuthor, publisherHost) || !looksLikePerson(rawAuthor);
    outlet = mastheadForDomain(publisherHost) ?? (keepAuthor ? null : deriveOutletName(publisherHost));
  } else {
    outlet = null;
  }
  const sourceName = outlet ?? rawAuthor; // no nameable publisher → keep authorName as the header (status quo)
  const author =
    outlet && rawAuthor && rawAuthor.toLowerCase() !== outlet.toLowerCase() ? rawAuthor : null;

  return {
    url: str(links["article"]) ?? str(pick(doc, [...KEYS.url])), // keep the licensed/tracking link as-is
    outletUrl: publisherUrl ?? sourceUrl,
    title: str(pick(doc, [...KEYS.title])),
    sourceName,
    mediaType,
    countryCode: str(pick(doc, [...KEYS.countryCode])),
    reach: reachFromStatusLine(doc["statusLine"]),
    sentiment: sentimentFromStatusLine(doc["statusLine"]),
    publishedAt: isoDate(pick(doc, [...KEYS.publishedAt])), // no explicit date in this shape → usually null
    snippet: str(doc["text"]),
    author,
    briefName: str(doc["source"]) ?? topBrief,
    imageUrl: str(doc["image"]),
    matchedKeywords: keywords(doc["keywords"]),
    raw: doc,
  };
}

function toMention(doc: Record<string, Json>, topBrief: string | null): NormalizedMention {
  if (isEveryMention(doc)) return everyMentionToMention(doc, topBrief);
  return {
    url: str(pick(doc, [...KEYS.url])),
    outletUrl: null,
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
