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
  /** Hex colour for the message's left bar, so each Organisation Brief is visually distinct. */
  color?: string;
}

/** Left-bar colour used for the default brief and any brief without an explicit `color`. */
export const DEFAULT_BRIEF_COLOR = "#868e96";

/** Fold near-identical broadcast segments (same clip across stations) into one card. */
export interface NearDuplicateConfig {
  /** Master switch for broadcast near-dup merging. */
  enabled: boolean;
  /** Only look back this many hours for a near-duplicate to merge into (DB-level candidate cap). */
  windowHours: number;
  /** Hamming distance within which an identical SimHash short-circuits to accept (cheap fast path). */
  maxHammingDistance: number;
  /** Word-shingle size fed into the SimHash. */
  shingleSize: number;
  /**
   * Primary signal: min k-gram containment (overlap coefficient, |A∩B| / min(|A|,|B|)) required
   * to consider two transcripts the same reading.
   */
  minPhraseOverlap: number;
  /** Confirmation: min longest common contiguous word-run — the verbatim run that rejects coincidence. */
  minContiguousRun: number;
  /** Word k-gram size for the containment shingles (distinct from the SimHash `shingleSize`). */
  containmentShingleSize: number;
  /**
   * Guardrail: never merge two captures whose broadcast air-times (parsed from the title) differ by
   * more than this. The same reading re-airs across a news cycle, not days apart.
   */
  maxAirtimeGapHours: number;
  /** Media types this applies to (case-insensitive substring match against a mention's mediaType). */
  mediaTypes: string[];
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
  /** Broadcast near-duplicate merging (SimHash). */
  nearDuplicate: NearDuplicateConfig;
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
  nearDuplicate: {
    enabled: true,
    windowHours: 12,
    maxHammingDistance: 3,
    shingleSize: 3,
    minPhraseOverlap: 0.25,
    minContiguousRun: 12,
    containmentShingleSize: 5,
    maxAirtimeGapHours: 3,
    mediaTypes: ["radio", "tv", "television", "broadcast"],
  },
  defaultBriefLabel: "Media Monitoring",
  briefs: [
    // Real Meltwater searches (the payload's `source` field). `matchNames` match that value;
    // `keywords` drive the pill highlighting + "Mentions:" line — tune them as you see fit.
    {
      id: "mps",
      label: "MPs",
      matchNames: ["mps"],
      keywords: ["Andrew Wilkie", "Jacqui Scruby", "MP"],
      color: "#4263eb", // indigo
    },
    {
      id: "teals",
      label: "Teals",
      matchNames: ["teals"],
      keywords: ["teal", "independent"],
      color: "#0ca678", // teal
    },
    {
      id: "climate-200",
      label: "Climate 200",
      matchNames: ["climate 200"],
      keywords: ["Climate 200"],
      color: "#f76707", // orange
    },
    {
      id: "vic-state",
      label: "Vic State",
      matchNames: ["vic state"],
      keywords: [],
      color: "#ae3ec9", // purple
    },
  ],
};
