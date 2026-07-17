/**
 * The broadcast near-duplicate predicate, extracted so BOTH the live ingestion path
 * (`process.ts:findNearDup`) and the retroactive coalesce tool (`coalesce.ts`) share one
 * definition of "these two broadcast readings are the same story". Keeping it in one place is what
 * lets the coalesce backfill faithfully reproduce what ingestion would have done — by construction,
 * not by copy-paste that can drift.
 */
import type { StoryRow } from "@/lib/story";
import type { NearDuplicateConfig } from "@/config/feed.config";
import { broadcastAirtime } from "@/lib/slack/format";
import { buildSketch, phraseNearDup, type PhraseSketch } from "@/lib/nearmatch";
import { hammingDistance } from "@/lib/simhash";

/** One side of a near-dup comparison — either an incoming mention or a stored story, reduced to the
 * four signals the predicate needs. */
export interface NearDupSide {
  /** 64-bit SimHash fingerprint, or null when the text was too short to fingerprint. */
  fp: bigint | null;
  /** Phrase sketch (tokens + shingles) for containment/run matching, or null for too-little text. */
  sketch: PhraseSketch | null;
  /** Broadcast air-time (epoch ms) parsed from the title, or null when absent/unparseable. */
  airtime: number | null;
  /** Lowercased media type, for the same-medium guard. */
  mediaType: string;
}

/** The primary mention's title + snippet, recovered from a story row (null on any parse failure). */
export function primaryOf(row: StoryRow): { title: string | null; snippet: string | null } {
  try {
    const p = JSON.parse(row.primary_mention_json) as { title?: string | null; snippet?: string | null };
    return { title: p.title ?? null, snippet: p.snippet ?? null };
  } catch {
    return { title: null, snippet: null };
  }
}

/** Broadcast air-time (epoch ms) parsed from a title's RFC tail, or null when absent/unparseable. */
export function airtimeMs(title: string | null): number | null {
  const tail = broadcastAirtime(title);
  if (!tail) return null;
  const t = Date.parse(tail);
  return Number.isNaN(t) ? null : t;
}

/** Reduce a stored story row to its comparison side (candidate side of a near-dup check). */
export function sideForStory(row: StoryRow, cfg: NearDuplicateConfig): NearDupSide {
  const prim = primaryOf(row);
  return {
    fp: row.simhash ? BigInt(row.simhash) : null,
    sketch: buildSketch(prim.snippet, cfg.containmentShingleSize),
    airtime: airtimeMs(prim.title),
    mediaType: (row.media_type ?? "").toLowerCase(),
  };
}

export interface NearDupVerdict {
  /** The pair are near-duplicates. */
  match: boolean;
  /** Matched via the SimHash fast path (identical-enough fingerprint) rather than phrase work. */
  fast: boolean;
  /** Phrase overlap coefficient for ranking candidates (1 for a fast-path hit, -1 when no match). */
  overlap: number;
}

/**
 * Are two broadcast readings the same story? Mirrors the per-candidate body of the live
 * `findNearDup` loop exactly: two hard guards first (same media type; air-times within
 * `maxAirtimeGapHours` when BOTH parse), then an identical-enough SimHash is a free accept (fast
 * path), else the transcripts must clear phrase containment AND a contiguous verbatim run.
 * Symmetric, so argument order doesn't affect the verdict.
 */
export function isNearDupPair(a: NearDupSide, b: NearDupSide, cfg: NearDuplicateConfig): NearDupVerdict {
  const NO: NearDupVerdict = { match: false, fast: false, overlap: -1 };
  // Guard 1 — same media type only (radio↔radio, tv↔tv).
  if (a.mediaType !== b.mediaType) return NO;
  // Guard 2 — air-time proximity, only enforced when BOTH air-times parse.
  if (a.airtime !== null && b.airtime !== null && Math.abs(a.airtime - b.airtime) > cfg.maxAirtimeGapHours * 3_600_000) {
    return NO;
  }
  // Fast path — an all-but-identical fingerprint is the same reading; accept without phrase work.
  if (a.fp !== null && b.fp !== null && hammingDistance(a.fp, b.fp) <= cfg.maxHammingDistance) {
    return { match: true, fast: true, overlap: 1 };
  }
  // Primary signal — k-gram containment + contiguous verbatim run over the transcripts.
  if (!a.sketch || !b.sketch) return NO;
  const { overlap, match } = phraseNearDup(a.sketch, b.sketch, {
    minPhraseOverlap: cfg.minPhraseOverlap,
    minContiguousRun: cfg.minContiguousRun,
  });
  return { match, fast: false, overlap };
}
