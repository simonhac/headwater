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
  "australianconveyancer.com.au": "Australian Conveyancer",
  "australianjewishnews.com": "The Australian Jewish News",
  "ajn.timesofisrael.com": "The Australian Jewish News", // AJN's newer co-branded domain
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
  "nine.com.au": "9News",
  "perthnow.com.au": "PerthNow",
  "skynews.com.au": "Sky News",
  "smh.com.au": "The Sydney Morning Herald",
  "theage.com.au": "The Age",
  "theaustralian.com.au": "The Australian",
  "theguardian.com": "The Guardian",
  "thewest.com.au": "The West Australian",
  "watoday.com.au": "WAtoday",
  // --- bylined domains observed in the redecode dry-run (authorName was a journalist; the domain's
  // derived name would be an ugly concatenation, so map it to the real masthead) ---
  "fleurieusun.com.au": "Fleurieu Sun",
  "gippslandmonitor.com.au": "Gippsland Monitor",
  "liberal.org.au": "Liberal Party Media Release",
  "manlyobserver.com.au": "Manly Observer",
  "regionalmediaconnect.com.au": "Regional Media Connect",
  "sheppnews.com.au": "Shepparton News",
  "themercury.com.au": "The Mercury",
  "viewfromthewing.com": "View from the Wing",
  "wangarattachronicle.com.au": "Wangaratta Chronicle",
  "yourlifechoices.com.au": "YourLifeChoices",
};

// Outlet/organisation words: a byline candidate containing one is a masthead, not a person's name.
const OUTLET_WORDS = new Set([
  "news", "times", "herald", "post", "mail", "sun", "age", "daily", "weekly", "bulletin", "chronicle",
  "advertiser", "observer", "monitor", "gazette", "journal", "tribune", "star", "mercury", "guardian",
  "australian", "australia", "conversation", "wire", "network", "media", "press", "radio", "tv",
  "television", "fm", "am", "magazine", "online", "digital", "report", "review", "today", "nation",
  "national", "indigenous", "jewish", "catholic", "party", "the", "of", "and", "for",
]);

/**
 * Heuristic: does `name` read like a person's byline (2–3 capitalised words, no outlet/org words) as
 * opposed to a masthead? Gates whether we demote `authorName` to the byline and recover the outlet from
 * the publisher domain. Deliberately conservative — unsure ⇒ false, so we keep `authorName` as the
 * outlet rather than mangling a real masthead ("Chelsea Mordialloc Mentone News") into a derived name.
 */
export function looksLikePerson(name: string | null): boolean {
  if (!name) return false;
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  const wordRe = /^[A-Z][a-z]*(?:['’-][A-Za-z][a-z]*)*$/; // Capitalised; allows O'Brien, Garbutt-Young
  if (!words.every((w) => wordRe.test(w))) return false;
  return !words.some((w) => OUTLET_WORDS.has(w.toLowerCase()));
}

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

// Public suffixes we strip to isolate the registrable label. Longest (most specific) first so e.g.
// "com.au" wins over "au"/"com". AU-focused, with the common global TLDs the feed also carries.
const PUBLIC_SUFFIXES = [
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "asn.au", "id.au",
  "co.uk", "org.uk", "co.nz",
  "com", "net", "org", "news", "media", "co", "io", "au", "nz", "uk",
];

/**
 * Best-effort display name for a publisher host that isn't in MASTHEAD_BY_DOMAIN. Strips a generic
 * leading subdomain and the public suffix, then title-cases the registrable label on word breaks —
 * e.g. "some-local-news.com.au" → "Some Local News". Concatenated single-word
 * domains ("australianconveyancer.com.au") can't be split and come back as one word; map those in the
 * table when the exact wording matters. Returns null for an empty/garbage host.
 */
export function deriveOutletName(host: string | null): string | null {
  if (!host) return null;
  let labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length > 2 && ["www", "m", "mobile", "amp"].includes(labels[0]!)) labels = labels.slice(1);
  for (const suffix of PUBLIC_SUFFIXES) {
    const parts = suffix.split(".");
    if (labels.length > parts.length && labels.slice(-parts.length).join(".") === suffix) {
      labels = labels.slice(0, -parts.length);
      break;
    }
  }
  const core = labels[labels.length - 1];
  if (!core) return null;
  const name = core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return name || null;
}
