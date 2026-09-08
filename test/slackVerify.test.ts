import { describe, it, expect } from "vitest";
import { slackSignature, verifySlackSignature, SLACK_MAX_SKEW_MS } from "@/lib/slack/verify";

// Slack's own worked example (api.slack.com/authentication/verifying-requests-from-slack).
const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TS = "1531420618";
const BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const EXPECTED = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
const NOW = Number(TS) * 1000 + 1000;

describe("slack request signing", () => {
  it("reproduces Slack's documented signature", async () => {
    expect(await slackSignature(SECRET, TS, BODY)).toBe(EXPECTED);
  });

  it("accepts a correctly signed, fresh request", async () => {
    expect(await verifySlackSignature({ signingSecret: SECRET, timestamp: TS, signature: EXPECTED, rawBody: BODY, nowMs: NOW })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    expect(
      await verifySlackSignature({ signingSecret: SECRET, timestamp: TS, signature: EXPECTED, rawBody: BODY + "&x=1", nowMs: NOW }),
    ).toBe(false);
  });

  it("rejects a replay outside the 5-minute window", async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: EXPECTED,
        rawBody: BODY,
        nowMs: NOW + SLACK_MAX_SKEW_MS + 1000,
      }),
    ).toBe(false);
  });

  it("fails closed on anything missing or malformed", async () => {
    const base = { signingSecret: SECRET, timestamp: TS, signature: EXPECTED, rawBody: BODY, nowMs: NOW };
    expect(await verifySlackSignature({ ...base, signingSecret: undefined })).toBe(false);
    expect(await verifySlackSignature({ ...base, signature: undefined })).toBe(false);
    expect(await verifySlackSignature({ ...base, timestamp: "not-a-number" })).toBe(false);
    expect(await verifySlackSignature({ ...base, signature: "v0=00" })).toBe(false);
  });
});
