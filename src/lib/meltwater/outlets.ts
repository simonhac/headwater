/**
 * Outlet identity for the Meltwater "Every Mention" payloads.
 *
 * That format has a single name field (`authorName`) which is the OUTLET for some content
 * (radio stations, local papers) but the JOURNALIST for wire/agency/syndicated content. When it's
 * a byline we can still recover the masthead from the publisher domain (`links.source`). This map
 * is derived from the archived corpus: it lists the domains that showed a byline, mapping each to
 * its masthead. Domains whose `authorName` is already the masthead are intentionally absent — there
 * we keep `authorName`.
 */
const MASTHEAD_BY_DOMAIN: Record<string, string> = {
  // --- observed in the archived corpus (authorName was a byline) ---
  "abc.net.au": "ABC",
  "afr.com": "Australian Financial Review",
  "ausdoc.com.au": "Australian Doctor",
  "australianjewishnews.com": "The Australian Jewish News",
  "cathnews.com": "CathNews",
  "cessnockadvertiser.com.au": "Cessnock Advertiser",
  "courier.net.au": "The Courier",
  "crikey.com.au": "Crikey",
  "heraldsun.com.au": "Herald Sun",
  "juneesoutherncross.com.au": "Junee Southern Cross",
  "nit.com.au": "National Indigenous Times",
  "nvi.com.au": "Namoi Valley Independent",
  "portnews.com.au": "Port Macquarie News",
  "theconversation.com": "The Conversation",
  "thenewdaily.com.au": "The New Daily",
  "thenightly.com.au": "The Nightly",
  "tvblackbox.com.au": "TV Blackbox",
  // --- major AU mastheads seeded proactively (bylines in authorName) ---
  "adelaidenow.com.au": "The Advertiser",
  "brisbanetimes.com.au": "Brisbane Times",
  "couriermail.com.au": "The Courier-Mail",
  "dailytelegraph.com.au": "The Daily Telegraph",
  "news.com.au": "news.com.au",
  "perthnow.com.au": "PerthNow",
  "skynews.com.au": "Sky News",
  "smh.com.au": "The Sydney Morning Herald",
  "theage.com.au": "The Age",
  "theaustralian.com.au": "The Australian",
  "theguardian.com": "The Guardian",
  "thewest.com.au": "The West Australian",
  "watoday.com.au": "WAtoday",
};

/** Host of a URL, lowercased, without a leading "www." (null if unparseable). */
export function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Masthead for a publisher host (matches the host or any subdomain of it); null if unknown. */
export function mastheadForDomain(host: string | null): string | null {
  if (!host) return null;
  for (const [domain, name] of Object.entries(MASTHEAD_BY_DOMAIN)) {
    if (host === domain || host.endsWith("." + domain)) return name;
  }
  return null;
}
