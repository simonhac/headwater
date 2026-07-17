# Headwater — duplicate detection

## Context

A single news item is often reported many times. Headwater collapses those repeats into **one**
Slack card (Streem-style: one story, the extra sources listed as "Also in …") instead of spamming
the channel. There are three distinct ways a repeat arrives, and each needs a different key:

1. **Exact re-delivery** — Meltwater sends the same mention twice (retry, reconcile). Caught by an
   exact dedupe key.
2. **Print / online syndication** — the same wire copy runs under many mastheads with the **same
   headline**. Caught by normalizing the title.
3. **Broadcast re-transcription** — this doc's focus. The **same radio/TV reading airs across many
   stations**; each is machine-transcribed (ASR) independently, so it arrives with a *different*
   `program – airtime` title, small transcription typos, and a snippet that is a **~300-char window
   anchored around the matched keyword** — meaning each capture's lead-in and tail differ even when
   the core sentence is word-for-word identical.

Broadcast is the hard case: the title differs (so title-normalization misses), the URL differs (so
exact dedupe misses), and — the crux — a whole-transcript fingerprint is dominated by the differing
window ends. This is exactly the "multiple postings of clearly the same interview" symptom.

## The three layers

| Layer | Key | Catches | Code |
|---|---|---|---|
| Exact dedupe | `sha256(brief.id \| url ?? "source\|title")` | true re-delivery | `seen_mentions`, `src/lib/store/seen.ts` |
| Title syndication | `sha256(normalizeTitle(title))` | verbatim wire republication | `stories.story_key`, `src/lib/story.ts` |
| **Broadcast phrase near-dup** | **shared verbatim phrase** | **same reading, different ASR/window** | `src/lib/nearmatch.ts`, `src/lib/process.ts` |

Layers 1–2 run first (cheap, exact). Only broadcast media (`radio`/`tv`/…) that survives both
reaches layer 3.

## How broadcast near-dup works

Two broadcast mentions are the **same reading** only when the transcripts clear **both** of these
(computed by `phraseNearDup` in `src/lib/nearmatch.ts`):

1. **k-gram containment ≥ `minPhraseOverlap`** — the *overlap coefficient*
   `|shingles(A) ∩ shingles(B)| / min(|A|, |B|)` over word 5-grams. It is **min-based, not Jaccard**,
   so a short capture fully inside a longer one still scores ~1.0 (Jaccard would dilute it by length).
   Cheap set intersection; typo-robust (an ASR typo only removes the handful of shingles spanning it).
2. **longest common contiguous word-run ≥ `minContiguousRun`** — a *verbatim* run of consecutive
   normalized words. This is the false-positive killer, and the reason we key on **phrases** rather
   than global similarity: the shared reading is a contiguous block; the differing window ends are
   not.

Requiring **both** (AND) is deliberate — containment alone can fire on scattered common words; a long
run alone could be a shared soundbite. Because the signal keys on the *overlap itself*, it is immune
to the windowing problem that defeats a whole-transcript fingerprint.

A whole-transcript SimHash (`src/lib/simhash.ts`) is still computed and stored, but only as a **fast
path**: an all-but-identical fingerprint (Hamming ≤ `maxHammingDistance`) short-circuits to "accept"
without the phrase work, and the `simhash IS NOT NULL` column is the cheap broadcast candidate gate.
It is no longer the deciding signal (see "Why not just SimHash?" below).

### Guardrails — never collapse across media type or a long time gap

Two hard preconditions gate **every** candidate *before* the phrase test (`findNearDup` in
`src/lib/process.ts`); failing either skips the candidate entirely, even on an identical transcript:

- **Same media type.** The incoming mention's normalized `mediaType` must equal the candidate story's
  `media_type`. A radio clip only merges with radio, TV only with TV. (Print never enters the pool —
  only broadcast items get a fingerprint.)
- **Air-time proximity.** The two captures' **broadcast air-times** (parsed from the title tail via
  `broadcastAirtime`, timezone-aware) must be within `maxAirtimeGapHours`. This is the true "temporal
  separation" signal — the same reading re-airs across a news cycle, not days apart. When a title's
  air-time can't be parsed, we fall back to the `windowHours` receipt-time bound only.

## Why we're confident the balance is right

The thresholds were not guessed — they were fit against a **real production export** (49 webhook
events → 11 real radio transcripts forming 3 genuine duplicate clusters, each aired on 3 stations:
"Wilkie / red carpet", "Wilkie / gambling licence", "Chaney / AI policy"). Measured over all
`11 choose 2 = 55` pairs, with the 3 clusters as ground truth:

| | longest verbatim word-run | 5-gram containment |
|---|---|---|
| **True duplicates** (9 pairs) | min **16** | min **0.33** |
| **Non-duplicates** (46 pairs) | max **9** | max **0.16** |

There is a **clean empty gap on both axes** — no true duplicate scores as low as any non-duplicate.
The production thresholds sit in the middle of that gap:

- `minContiguousRun = 12` — above the 9-word noise ceiling (coincidental stock phrases like *"rolling
  out the red carpet to a predatory industry"* max out at 9 words), below the 16-word weakest true
  duplicate.
- `minPhraseOverlap = 0.25` — above the 0.16 noise ceiling, below the 0.33 weakest true duplicate.

**A threshold sweep confirms the safety margin.** Every rule in the tested grid — from loose
(`run ≥ 8, overlap ≥ 0.20`) to strict — produced **0 false positives** across all 46 non-duplicate
pairs. False positives are simply not the binding constraint; the gap is wide. The binding constraint
is on the *other* side: pushing the bar up to "near-identical" (`run ≥ 30`) catches only **2 of 9**
real duplicates, because the keyword-windowed excerpt means genuine repeats often share only ~50–70%
of their text. `run = 12` catches all 9 while staying comfortably clear of coincidence.

The **air-time guard** has similar headroom: every real cluster aired within **~1.5h**, and
`maxAirtimeGapHours = 3` is ~2× that — tight enough that a phrase re-used in a later bulletin is never
collapsed, loose enough that same-cycle re-airs always are.

Residual false-positive risk is small, bounded, and recoverable: two genuinely different segments that
*both* replay a ≥12-word verbatim soundbite **and** clear 25% containment **and** air within 3h **and**
share a media type would merge. That combination sits outside the empirical gap, and the failure mode
is a recoverable one — two cards folded into one, not lost data.

### Why not just SimHash?

The previous mechanism was a whole-transcript 64-bit SimHash merged at Hamming distance ≤ 3. Against
the same real export it caught **only 1 of the 9 duplicate pairs** — because it fingerprints the
*entire* window, so the differing (non-overlapping) lead-in/tail dominate the fingerprint and push the
distance well past 3 even when the shared sentence is verbatim. Keying on the shared phrase instead of
the whole window is what closes that ~89% miss rate.

## Tuning surface

All knobs live in one object — `feedConfig.nearDuplicate` (`src/config/feed.config.ts`):

```ts
nearDuplicate: {
  enabled: true,
  windowHours: 12,          // DB-level candidate cap (receipt time)
  maxHammingDistance: 3,    // SimHash fast-path accept band (fingerprint short-circuit only)
  shingleSize: 3,           // SimHash shingle size
  minPhraseOverlap: 0.25,   // ← primary: min k-gram overlap coefficient
  minContiguousRun: 12,     // ← primary: min verbatim word run
  containmentShingleSize: 5,// k for the containment shingles
  maxAirtimeGapHours: 3,    // ← guardrail: max broadcast air-time separation
  mediaTypes: ["radio", "tv", "television", "broadcast"],
}
```

To make merging **stricter** (fewer merges, even lower FP), raise `minContiguousRun` /
`minPhraseOverlap` or lower `maxAirtimeGapHours`. To make it **looser** (catch weaker repeats at some
FP risk), do the reverse. The empirically safe plateau is `minContiguousRun ∈ [10, 16]` and
`minPhraseOverlap ∈ [0.20, 0.33]`.

## Tests

- `test/nearmatch.test.ts` — the primitives, using the real cluster phrases: same-reading match,
  different-window match, single-typo robustness, the ≤9-word stock-phrase rejection (the key
  discriminator), overlap-coefficient-vs-Jaccard, and the null contract.
- `test/integration/pipeline.integration.test.ts` — end-to-end: two stations of the same reading
  merge into one card; a different bulletin sharing only the stock phrase stays separate; and the two
  guardrails (radio-vs-TV, and air-times > 3h apart) each block a merge despite an identical
  transcript.
