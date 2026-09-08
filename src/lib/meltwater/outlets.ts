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
  // --- pass one of the outlet-naming fixes (2026-09-08). Without an entry here `deriveOutletName`
  // title-cases the domain label, which produced "Sbs", "Bordermail", "Canberratimes" etc. Each name
  // below is verified: either Meltwater itself sent it as `authorName` on that same domain (its print
  // mentions carry the masthead, e.g. "The Border Mail (Print version)" — count in brackets), or it
  // was read off the publisher's own page title, or both. Do NOT guess a name from the domain here. ---
  "alpineobserver.com.au": "Alpine Observer & Myrtleford Times",
  "areanews.com.au": "The Area News",
  "au.finance.yahoo.com": "Yahoo Finance Australia", // keyed per-subdomain: a bare yahoo.com would
  "au.news.yahoo.com": "Yahoo News Australia", //       label Finance as News (subdomains inherit)
  "bordermail.com.au": "The Border Mail", // [14]
  "cairnspost.com.au": "The Cairns Post", // [3]
  "canberratimes.com.au": "The Canberra Times", // [2]
  "capitalbrief.com": "Capital Brief",
  "citynews.com.au": "Canberra CityNews", // their own masthead; Meltwater's print label inverts it
  "croakey.org": "Croakey Health Media",
  "dailyadvertiser.com.au": "The Daily Advertiser",
  "examiner.com.au": "The Examiner", // [2]
  "geelongadvertiser.com.au": "Geelong Advertiser", // [1]
  "gympietoday.com.au": "Gympie Today", // [1]
  "illawarramercury.com.au": "Illawarra Mercury",
  "irrigator.com.au": "The Irrigator",
  "kimberleyecho.com.au": "The Kimberley Echo",
  "marieclaire.com.au": "marie claire", // [2] genuinely lower-case brand — don't "fix" it
  "medicalrepublic.com.au": "Medical Republic", // no "The" — per the masthead on their own site
  "msn.com": "MSN",
  "naroomanewsonline.com.au": "Narooma News",
  "northerndailyleader.com.au": "The Northern Daily Leader",
  "northsidelivingnews.com.au": "Northside Living", // the site's brand; Meltwater's [1] label is stale
  "northwesttelegraph.com.au": "North West Telegraph",
  "ntnews.com.au": "NT News", // [4]
  "pittwateronlinenews.com": "Pittwater Online News", // [10]
  "postnewspapers.com.au": "POST Newspaper", // [6]
  "sbs.com.au": "SBS News",
  "southernhighlandnews.com.au": "Southern Highland News",
  "spectator.com.au": "The Spectator Australia", // [1]
  "standard.net.au": "The Standard",
  "startupdaily.net": "Startup Daily", // [1]
  "thechronicle.com.au": "The Chronicle", // [5]
  "thedailyaus.com.au": "The Daily Aus",
  "theherald.com.au": "Newcastle Herald", // [1] NOT "The Herald" — Nine's legacy Newcastle domain
  "theleader.com.au": "St George & Sutherland Shire Leader",
  "thesaturdaypaper.com.au": "The Saturday Paper", // [2]
  "weeklytimesnow.com.au": "The Weekly Times", // [1]
};

// Outlet/organisation words: a byline candidate containing one is a masthead, not a person's name.
const OUTLET_WORDS = new Set([
  "news", "times", "herald", "post", "mail", "sun", "age", "daily", "weekly", "bulletin", "chronicle",
  "advertiser", "observer", "monitor", "gazette", "journal", "tribune", "star", "mercury", "guardian",
  "australian", "australia", "conversation", "wire", "network", "media", "press", "radio", "tv",
  "television", "fm", "am", "magazine", "online", "digital", "report", "review", "today", "nation",
  "national", "indigenous", "jewish", "catholic", "party", "the", "of", "and", "for",
  // Parliamentary sources: Meltwater's authorName for aph.gov.au is "Senate Official Hansard", which is
  // three capitalised words and would otherwise read as a byline. Deliberately NOT "house"/"official" —
  // both occur in real names, and a false positive there lets a person headline a card as the outlet.
  "hansard", "senate", "parliament",
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
