import { timingSafeEqualStr } from "@/lib/ids";

/**
 * Slack request signing (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * Slack signs every inbound request (slash commands, interactivity) with the app's Signing Secret:
 *   X-Slack-Signature = "v0=" + hex(HMAC-SHA256(secret, "v0:" + X-Slack-Request-Timestamp + ":" + rawBody))
 * The timestamp is also checked against our clock so a captured request can't be replayed later.
 * Fail-closed on anything missing or malformed.
 */

/** Slack's recommended replay window. */
export const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;

export async function slackSignature(signingSecret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

export async function verifySlackSignature(p: {
  signingSecret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs: number;
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody, nowMs } = p;
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs - Number(timestamp) * 1000) > SLACK_MAX_SKEW_MS) return false;
  const expected = await slackSignature(signingSecret, timestamp, rawBody);
  return timingSafeEqualStr(expected, signature);
}
