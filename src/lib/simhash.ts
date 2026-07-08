/**
 * 64-bit SimHash for near-duplicate transcript matching.
 *
 * Broadcast items (radio/TV) carry the same segment across many stations, but each has a
 * different `program - airtime` title and a slightly different speech-to-text, so exact URL /
 * title / snippet keys all miss. SimHash maps similar text to fingerprints that differ in only a
 * few bits, so "same segment?" becomes a cheap Hamming-distance check.
 */

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a 64-bit hash of a string → bigint in [0, 2^64). */
function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Lowercase, strip punctuation, collapse whitespace → word tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** w-word shingles (falls back to the raw tokens when the text is shorter than w). */
export function shingles(tokens: string[], w: number): string[] {
  if (tokens.length < w) return tokens.slice();
  const out: string[] = [];
  for (let i = 0; i + w <= tokens.length; i++) out.push(tokens.slice(i, i + w).join(" "));
  return out;
}

/**
 * 64-bit SimHash over w-shingles of `text`. Returns null when there's too little signal
 * (empty/short text) to fingerprint reliably.
 */
export function simhash64(text: string | null, shingleSize = 3, minTokens = 4): bigint | null {
  if (!text) return null;
  const tokens = tokenize(text);
  if (tokens.length < minTokens) return null;
  const bits = new Array<number>(64).fill(0);
  for (const feature of shingles(tokens, shingleSize)) {
    const h = fnv1a64(feature);
    for (let i = 0; i < 64; i++) bits[i]! += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let fp = 0n;
  for (let i = 0; i < 64; i++) if (bits[i]! > 0) fp |= 1n << BigInt(i);
  return fp;
}

/** Number of differing bits between two fingerprints (popcount of the XOR). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let d = 0;
  while (x) {
    x &= x - 1n;
    d++;
  }
  return d;
}
