import { describe, it, expect } from "vitest";
import { buildSketch, overlapCoefficient, longestCommonRun, phraseNearDup } from "@/lib/nearmatch";

// Production defaults (feedConfig.nearDuplicate): 5-gram containment ≥ 0.25 AND a ≥12-word run.
const K = 5;
const OPTS = { minPhraseOverlap: 0.25, minContiguousRun: 12 };
const match = (a: string, b: string) =>
  phraseNearDup(buildSketch(a, K)!, buildSketch(b, K)!, OPTS);

// The verbatim sentence a syndicated radio bulletin carries across stations.
const CORE =
  "Federal Independent MP Andrew Wilkie has accused the state government of rolling out the red carpet to a predatory industry by approving a new gambling licence to online bookmaker";

describe("buildSketch", () => {
  it("returns null for empty or too-short text (too little signal)", () => {
    expect(buildSketch(null, K)).toBeNull();
    expect(buildSketch("", K)).toBeNull();
    expect(buildSketch("only four words here", K)).toBeNull(); // 4 tokens < shingleSize 5
  });

  it("tokenizes and builds a shingle set", () => {
    const s = buildSketch("The quick brown fox jumps", K)!;
    expect(s.tokens).toEqual(["the", "quick", "brown", "fox", "jumps"]);
    expect([...s.shingles]).toEqual(["the quick brown fox jumps"]);
  });
});

describe("phraseNearDup — same reading (real cluster phrases)", () => {
  // Two ASR captures of the SAME clip, different typos (the A/B pair used elsewhere in the suite).
  const A =
    "unable to make calls or use data on their mobile phones or other devices. Telstra says they are investigating the issue. Federal independent MP Andrew Wilkie has slammed the state government after they approved a new gambling license to online bookmaker better. Mr Wilkie saying the movie is rolling";
  const B =
    "unable to make calls or use data on their mobile phones or other devices. Telstra says they are investigating the issue. Federal Independent MP Andrew Wilkie. has slammed the state government after they approved a new gambling license to online bookmaker Better, Mr Wilkie saying the movie is rolling";

  it("matches near-identical ASR variants", () => {
    const r = match(A, B);
    expect(r.overlap).toBeGreaterThanOrEqual(0.25);
    expect(r.run).toBeGreaterThanOrEqual(12);
    expect(r.match).toBe(true);
  });

  it("matches the same core sentence even when the windowed lead-in is totally different", () => {
    // Real symptom: the ~300-char excerpt is anchored around the keyword, so lead-ins diverge.
    const w1 = `the other end of the state his death prompted discussions around fatigue management for health workers ${CORE}`;
    const w2 = `lincoln quilliam there enter his weapon for the event in the coming weeks held in march next year ${CORE}`;
    const r = match(w1, w2);
    expect(r.run).toBeGreaterThanOrEqual(12); // shares the whole CORE sentence verbatim
    expect(r.match).toBe(true);
  });

  it("survives a single mid-phrase ASR typo (the run splits but a flank stays long)", () => {
    const typo = CORE.replace("accused", "accuse");
    const r = match(CORE, typo);
    expect(r.match).toBe(true);
  });
});

describe("phraseNearDup — NOT duplicates (the false-positive guard)", () => {
  it("rejects a shared ≤9-word stock phrase between different bulletins", () => {
    const stock = "rolling out the red carpet to a predatory industry"; // 9 words — a real recurring clause
    const one = `the government today defended its decision amid criticism that it was ${stock} according to the opposition`;
    const two = `consumer advocates warned the policy risked ${stock} and called for an urgent review by regulators`;
    const r = match(one, two);
    expect(r.run).toBe(9); // the longest verbatim run is exactly the 9-word clause
    expect(r.match).toBe(false); // 9 < minContiguousRun (12) → not merged
  });

  it("rejects unrelated transcripts", () => {
    const other =
      "The Prime Minister today announced a new renewable energy target as part of the government climate policy agenda for the coming decade ahead of the next election";
    expect(match(CORE, other).match).toBe(false);
  });
});

describe("overlapCoefficient — min-based, not Jaccard", () => {
  it("scores ~1.0 when a short excerpt is fully contained in a longer transcript", () => {
    const short = CORE;
    const long = `and now the local news at six ${CORE} that report from our state political correspondent live at parliament house this evening`;
    const a = buildSketch(short, K)!;
    const b = buildSketch(long, K)!;
    // Every 5-gram of the short excerpt appears in the long one → overlap coefficient ≈ 1.0.
    expect(overlapCoefficient(a.shingles, b.shingles)).toBeGreaterThan(0.9);
  });

  it("is 0 when either set is empty", () => {
    expect(overlapCoefficient(new Set(), new Set(["a b c"]))).toBe(0);
  });
});

describe("longestCommonRun", () => {
  it("counts the longest contiguous shared token run", () => {
    const a = "alpha beta gamma delta epsilon".split(" ");
    const b = "zzz beta gamma delta yyy".split(" ");
    expect(longestCommonRun(a, b)).toBe(3); // beta gamma delta
  });

  it("is 0 with no shared tokens or an empty side", () => {
    expect(longestCommonRun(["a", "b"], ["c", "d"])).toBe(0);
    expect(longestCommonRun([], ["a"])).toBe(0);
  });
});
