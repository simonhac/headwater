/**
 * A single media mention, normalized from whatever shape Meltwater's Generic
 * Webhook actually sends. The webhook payload schema is not publicly documented,
 * so `parse.ts` extracts these fields defensively (many candidate key names) and
 * we tighten it once a real payload is captured via /inspect.
 */
export interface NormalizedMention {
  url: string | null;
  title: string | null;
  sourceName: string | null;
  mediaType: string | null; // news / online_news / radio / social / print ...
  countryCode: string | null;
  reach: number | null;
  sentiment: string | null; // positive / neutral / negative
  publishedAt: string | null; // ISO-8601 if we can parse it
  snippet: string | null; // opening text / hit sentence / summary
  author: string | null;
  briefName: string | null; // alert / saved-search name -> "Organisation Brief"
  imageUrl: string | null;
  /** Matched keywords from the payload if present; otherwise derived from config keywords later. */
  matchedKeywords: string[];
  /** The original per-document object, for /inspect and schema-tightening. */
  raw: unknown;
}
