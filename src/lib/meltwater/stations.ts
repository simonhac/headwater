/**
 * Meltwater broadcast station codes → display names.
 *
 * The "Every Mention" webhook doesn't carry the station for radio/TV — `authorName` is either the
 * station ("7BU 558 AM") or the reporter ("Glen Norris"), and the station name only exists on the
 * broadcast viewer. Following `links.article` server-side yields (via a meta-refresh) a `mediaView`
 * URL whose token decodes to `Station=<code>` — a stable numeric code (no auth needed to read it).
 * This maps those codes to names.
 *
 * Seed pairs were harvested from the archive (events whose `authorName` WAS the station) plus two
 * confirmed by click-through. Extend as new stations appear. NOTE: using this at ingestion means
 * one extra fetch of the transition link per radio item to read the code — cheap and (as far as we
 * can tell) credit-free, since the transition page is just a redirect shim, but worth confirming
 * with Meltwater. A proper Meltwater API would supersede this.
 */
export const STATION_BY_CODE: Record<string, string> = {
  "8650": "4BC 1116 News Talk", // confirmed via broadcast viewer
  "8670": "6PR 882 News Talk", // confirmed via broadcast viewer
  "7670": "ABC RN", // Radio National (also resolves via abc.net.au)
  "11655": "ABC Kimberley",
  "12760": "ABC Esperance",
  "15920": "7BU 558 AM",
  "15925": "Sea FM 101.7",
  "15935": "98.9 7AD FM",
  "15950": "7XS West Coast Radio Tasmania",
};

/** Station name for a Meltwater broadcast code, or null if unknown. */
export function stationForCode(code: string | null | undefined): string | null {
  return code ? (STATION_BY_CODE[code] ?? null) : null;
}
