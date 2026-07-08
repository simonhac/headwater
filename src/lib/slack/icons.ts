/** Small square icon for any domain (Google's favicon service — returns a globe for unknown
 * domains, so it never 404s a broken image; safe as a universal logo fallback). */
function googleFavicon(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

/**
 * Per-outlet logos, keyed by a lowercase substring of the source name. The outlet's real
 * domain is turned into a favicon so the on-air brand shows even when the article URL is a
 * clip/aggregator link (common for broadcast). Extend freely — most specific names first.
 */
const SOURCE_LOGOS: Record<string, string> = {
  "the australian": googleFavicon("theaustralian.com.au"),
  "sky news": googleFavicon("skynews.com.au"),
  "renew economy": googleFavicon("reneweconomy.com.au"),
  "the guardian": googleFavicon("theguardian.com"),
  abc: googleFavicon("abc.net.au"),
};

/** Favicon derived from the article URL's own domain — the default when a source isn't mapped. */
export function faviconUrl(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    return host ? googleFavicon(host) : null;
  } catch {
    return null;
  }
}

/** Best logo image URL for a mention's outlet: curated map first, then the article's own domain. */
export function sourceLogoUrl(sourceName: string | null, pageUrl: string | null): string | null {
  if (sourceName) {
    const key = sourceName.toLowerCase();
    for (const [name, url] of Object.entries(SOURCE_LOGOS)) {
      if (key.includes(name)) return url;
    }
  }
  return faviconUrl(pageUrl);
}

// Checked in order; "online" must precede "news"/"print" so "online_news" resolves to 🌐.
const MEDIA_EMOJI: Array<[string, string]> = [
  ["radio", "📻"],
  ["television", "📺"],
  ["tv", "📺"],
  ["online", "🌐"],
  ["web", "🌐"],
  ["social", "💬"],
  ["blog", "💬"],
  ["print", "📰"],
  ["news", "📰"],
];

/** Fallback glyph for the outlet line when there's no logo image (no URL and not in the map). */
export function mediaTypeEmoji(mediaType: string | null): string {
  if (mediaType) {
    const k = mediaType.toLowerCase();
    for (const [t, e] of MEDIA_EMOJI) if (k.includes(t)) return e;
  }
  return "📰";
}
