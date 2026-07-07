/** Time-sortable event id: zero-padded epoch-ms + random hex suffix. */
export function eventId(receivedAt: number): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${receivedAt.toString().padStart(15, "0")}-${hex}`;
}

/** SHA-256 hex of a string (used to key the dedupe store by canonical url). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secret/token checks. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
