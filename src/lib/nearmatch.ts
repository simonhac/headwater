/**
 * Contiguous shared-phrase near-duplicate matching for broadcast transcripts.
 *
 * Machine-transcribed radio/TV airs the same reading across many stations, but Meltwater sends a
 * ~300-char snippet windowed around the matched keyword — so each capture's lead-in/tail differs
 * even when the core sentence is verbatim-identical. A whole-transcript SimHash (see `simhash.ts`)
 * is dominated by those differing ends and misses the overlap. This module keys directly on the
 * shared segment instead:
 *   1. k-gram containment (overlap coefficient) — cheap, typo-robust set overlap.
 *   2. longest common contiguous word-run — the verbatim run that rejects coincidental stock
 *      phrases (which top out at ~9 words) while catching genuine re-transcriptions.
 * A pair is a duplicate only when BOTH clear their thresholds (see `feedConfig.nearDuplicate`).
 */
import { tokenize, shingles } from "@/lib/simhash";

export interface PhraseSketch {
  /** Normalized word tokens (for the contiguous-run check). */
  tokens: string[];
  /** Deduped w-word shingles (for the containment check). */
  shingles: Set<string>;
}

/**
 * Tokens + shingle-set for a transcript, or null when there's too little signal (empty text, or
 * fewer than `minTokens` tokens) — mirroring `simhash64`'s null-for-too-little-signal contract.
 */
export function buildSketch(text: string | null, shingleSize: number, minTokens = shingleSize): PhraseSketch | null {
  if (!text) return null;
  const tokens = tokenize(text);
  if (tokens.length < minTokens) return null;
  return { tokens, shingles: new Set(shingles(tokens, shingleSize)) };
}

/**
 * |A ∩ B| / min(|A|, |B|) — the overlap coefficient (min-based, NOT Jaccard). Min-based so a short
 * capture fully inside a longer one still scores ~1.0 where Jaccard would be diluted by length.
 * Iterates the smaller set → O(min).
 */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / small.size;
}

/**
 * Longest run of identical consecutive tokens shared by `a` and `b` (longest common substring over
 * tokens). Space-optimized DP: two rolling rows sized to the SHORTER array → O(min) space.
 */
export function longestCommonRun(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Iterate the outer loop over the longer array, keep the rolling rows over the shorter one.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  let best = 0;
  for (let j = 1; j <= long.length; j++) {
    const cur = new Array<number>(short.length + 1).fill(0);
    for (let i = 1; i <= short.length; i++) {
      if (long[j - 1] === short[i - 1]) {
        cur[i] = prev[i - 1]! + 1;
        if (cur[i]! > best) best = cur[i]!;
      }
    }
    prev = cur;
  }
  return best;
}

export interface PhraseMatch {
  overlap: number;
  run: number;
  match: boolean;
}

/**
 * Are two transcript sketches near-duplicates? Cheap containment gate first, then the expensive
 * contiguous-run confirmation only when containment clears — so `longestCommonRun` never runs on a
 * pair that already fails the overlap test.
 */
export function phraseNearDup(
  a: PhraseSketch,
  b: PhraseSketch,
  opts: { minPhraseOverlap: number; minContiguousRun: number },
): PhraseMatch {
  const overlap = overlapCoefficient(a.shingles, b.shingles);
  if (overlap < opts.minPhraseOverlap) return { overlap, run: 0, match: false };
  const run = longestCommonRun(a.tokens, b.tokens);
  return { overlap, run, match: run >= opts.minContiguousRun };
}
