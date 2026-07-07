/**
 * ★ THE TUNING SURFACE ★
 * Edit this file to shape the feed (Streem-style curation). Everything here is
 * data — the filter engine (src/lib/filter/engine.ts) is pure logic over it.
 *
 * Defaults start LENIENT so the first real webhooks show up in /inspect and you
 * can see actual field values before tightening (raise minSourceReach, set
 * includeMediaTypes, add sources to the allow/block lists, etc.).
 *
 * The `briefs` below are GENERIC EXAMPLES — replace them with your own search
 * names + keywords. A brief's `label` shows in the "Organisation Brief" column;
 * its `keywords` are highlighted in the snippet and counted in the "Mentions:" line.
 */

export interface BriefRule {
  id: string;
  /** Shown in the "Organisation Brief" column. */
  label: string;
  /** Match against the mention's brief/alert name (case-insensitive substring). */
  matchNames?: string[];
  /** Keywords to highlight in the snippet and to build the "Mentions: kw (n)" line. */
  keywords: string[];
  /** If true, drop mentions of this brief that contain none of `keywords`. */
  requireKeyword?: boolean;
  /** Optional Slack channel override for this brief. */
  channel?: string;
}

export interface FeedConfig {
  /** Drop below this reach. 0 = off (reach is only checked when present). */
  minSourceReach: number;
  /** If set, ONLY these media types pass. null = allow all. */
  includeMediaTypes: string[] | null;
  /** Always drop these media types (case-insensitive). */
  excludeMediaTypes: string[];
  /** If set, ONLY these source names pass (case-insensitive substring). null = allow all. */
  sourceAllowlist: string[] | null;
  /** Always drop these source names (case-insensitive substring). */
  sourceBlocklist: string[];
  /** If set, ONLY these country codes pass. null = allow all. */
  allowedCountryCodes: string[] | null;
  /** Drop mentions with no matched keywords at all. */
  requireMatchedKeyword: boolean;
  briefs: BriefRule[];
  /** Fallback brief label when none matches. */
  defaultBriefLabel: string;
}

export const feedConfig: FeedConfig = {
  minSourceReach: 0,
  includeMediaTypes: null,
  // Likely noise to exclude once you confirm the real media-type values in /inspect:
  excludeMediaTypes: [],
  sourceAllowlist: null,
  sourceBlocklist: [],
  allowedCountryCodes: null,
  requireMatchedKeyword: false,
  defaultBriefLabel: "Media Monitoring",
  briefs: [
    // --- replace these examples with your real Meltwater searches ---
    {
      id: "example-org",
      label: "Example Org",
      matchNames: ["example org", "example"],
      keywords: ["Example Org", "Example Foundation"],
    },
    {
      id: "example-people",
      label: "Key People",
      matchNames: ["key people"],
      keywords: ["Jane Doe", "John Smith"],
    },
  ],
};
