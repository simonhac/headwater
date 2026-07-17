import { describe, it, expect } from "vitest";
import { isNearDupPair, normMediaType, sameCrossMediaNetwork, type NearDupSide } from "@/lib/neardup";
import { buildSketch } from "@/lib/nearmatch";
import { feedConfig } from "@/config/feed.config";

const nd = feedConfig.nearDuplicate;

// Two transcripts sharing a long verbatim run (a real simulcast) — clears phrase overlap + run.
const SHARED =
  "he had quit the liberal party and would join the teals like he quit the uap and founded the liberals when he saw";
const side = (over: Partial<NearDupSide>): NearDupSide => ({
  fp: null, // force the phrase path (no SimHash fast accept)
  sketch: buildSketch(SHARED, nd.containmentShingleSize),
  airtime: null,
  mediaType: "radio",
  station: null,
  ...over,
});

describe("normMediaType", () => {
  it("collapses television → tv, lowercases", () => {
    expect(normMediaType("TELEVISION")).toBe("tv");
    expect(normMediaType("Radio")).toBe("radio");
    expect(normMediaType(null)).toBe("");
  });
});

describe("sameCrossMediaNetwork", () => {
  it("true only when both names contain a configured token", () => {
    expect(sameCrossMediaNetwork("ABC 24", "ABC NewsRadio", ["abc"])).toBe(true);
    expect(sameCrossMediaNetwork("ABC 24", "2GB", ["abc"])).toBe(false);
    expect(sameCrossMediaNetwork("ABC 24", "ABC NewsRadio", [])).toBe(false);
    expect(sameCrossMediaNetwork(null, "ABC NewsRadio", ["abc"])).toBe(false);
  });
});

describe("isNearDupPair — cross-media guard", () => {
  const cfg = { ...nd, crossMediaNetworks: ["abc"] };

  it("merges an ABC radio↔TV simulcast (same network) that shares a verbatim run", () => {
    const tv = side({ mediaType: "tv", station: "ABC News 24" });
    const radio = side({ mediaType: "radio", station: "ABC NewsRadio" });
    expect(isNearDupPair(tv, radio, cfg).match).toBe(true);
  });

  it("does NOT merge radio↔TV when the stations are different networks", () => {
    const tv = side({ mediaType: "tv", station: "9 Sydney" });
    const radio = side({ mediaType: "radio", station: "2GB" });
    expect(isNearDupPair(tv, radio, cfg).match).toBe(false);
  });

  it("does NOT merge cross-media ABC when there's no shared phrase run", () => {
    const tv = side({ mediaType: "tv", station: "ABC News 24", sketch: buildSketch("completely different words about another topic entirely here", nd.containmentShingleSize) });
    const radio = side({ mediaType: "radio", station: "ABC NewsRadio" });
    expect(isNearDupPair(tv, radio, cfg).match).toBe(false);
  });

  it("still merges same-media (tv↔television) regardless of network", () => {
    const a = side({ mediaType: normMediaType("television"), station: "9 Sydney" });
    const b = side({ mediaType: "tv", station: "9 Melbourne" });
    expect(isNearDupPair(a, b, cfg).match).toBe(true);
  });
});
