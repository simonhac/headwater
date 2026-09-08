import { describe, it, expect } from "vitest";
import {
  decideSubscriberSend,
  zonedMinuteOfDay,
  zonedDay,
  digestSubject,
  DEFAULT_SEND_MINUTE,
} from "@/lib/digestSend";
import { mailerConfig, formatFrom } from "@/lib/mailer";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import type { Env } from "@/env";

const TZ = "Australia/Melbourne";

// Melbourne is UTC+11 over daylight saving (Oct–Apr) and UTC+10 otherwise. These two instants are
// both 8am local, an hour apart in UTC — the per-subscriber gate must read both as 08:00.
const AEDT_8AM = Date.UTC(2026, 0, 15, 21, 0); // 15 Jan 2026 21:00Z = 08:00 AEDT on 16 Jan
const AEST_8AM = Date.UTC(2026, 6, 15, 22, 0); // 15 Jul 2026 22:00Z = 08:00 AEST on 16 Jul
const AEDT_DAY = "2026-01-16";

const sub = (over: Partial<{ time_zone: string; send_minute: number; last_sent_day: string | null }> = {}) => ({
  time_zone: TZ,
  send_minute: DEFAULT_SEND_MINUTE,
  last_sent_day: null,
  ...over,
});

describe("zoned clock", () => {
  it("reads 8am local at BOTH candidate UTC hours across the DST boundary", () => {
    expect(zonedMinuteOfDay(AEDT_8AM, TZ)).toBe(8 * 60);
    expect(zonedMinuteOfDay(AEST_8AM, TZ)).toBe(8 * 60);
  });

  it("returns minutes after midnight, with midnight as 0 (not 24)", () => {
    expect(zonedMinuteOfDay(Date.UTC(2026, 6, 15, 14, 0), TZ)).toBe(0); // 14:00Z = 00:00 AEST
    expect(zonedMinuteOfDay(Date.UTC(2026, 6, 15, 14, 45), TZ)).toBe(45);
    expect(zonedMinuteOfDay(Date.UTC(2026, 6, 15, 9, 30), "Europe/London")).toBe(10 * 60 + 30); // BST
  });

  it("returns the local calendar day as YYYY-MM-DD", () => {
    expect(zonedDay(AEDT_8AM, TZ)).toBe(AEDT_DAY);
    // 14:30Z on the 15th is already the 16th in Melbourne.
    expect(zonedDay(Date.UTC(2026, 6, 15, 14, 30), TZ)).toBe("2026-07-16");
  });
});

describe("decideSubscriberSend", () => {
  it("is due exactly at the chosen local time, in either DST regime", () => {
    expect(decideSubscriberSend({ nowMs: AEDT_8AM, sub: sub() }).due).toBe(true);
    expect(decideSubscriberSend({ nowMs: AEST_8AM, sub: sub() }).due).toBe(true);
  });

  it("is not yet due before the chosen time", () => {
    const d = decideSubscriberSend({ nowMs: AEDT_8AM - 15 * 60 * 1000, sub: sub() });
    expect(d).toMatchObject({ due: false, reason: "not_yet", minute: 7 * 60 + 45 });
  });

  it("catches up: still due later the same day if the slot was missed", () => {
    const d = decideSubscriberSend({ nowMs: AEDT_8AM + 3 * 60 * 60 * 1000, sub: sub() });
    expect(d.due).toBe(true);
  });

  it("never sends twice in one local day", () => {
    const d = decideSubscriberSend({ nowMs: AEDT_8AM, sub: sub({ last_sent_day: AEDT_DAY }) });
    expect(d).toMatchObject({ due: false, reason: "already_sent_today", day: AEDT_DAY });
  });

  it("sends again the next local day", () => {
    expect(decideSubscriberSend({ nowMs: AEDT_8AM, sub: sub({ last_sent_day: "2026-01-15" }) }).due).toBe(true);
  });

  it("honours the subscriber's own zone, not Melbourne's", () => {
    // 15 Jan 2026 21:00Z is 08:00 (16 Jan) in Melbourne but 21:00 (15 Jan) in London — a London 8am subscriber sent
    // that morning is done; one not yet sent today is (catch-up) due.
    const london = sub({ time_zone: "Europe/London" });
    expect(decideSubscriberSend({ nowMs: AEDT_8AM, sub: { ...london, last_sent_day: "2026-01-15" } }).due).toBe(false);
    expect(decideSubscriberSend({ nowMs: AEDT_8AM, sub: london }).due).toBe(true);
    // London 07:45 the same morning → not yet.
    expect(decideSubscriberSend({ nowMs: Date.UTC(2026, 0, 15, 7, 45), sub: london })).toMatchObject({
      due: false,
      reason: "not_yet",
    });
  });

  it("force bypasses the time gate but NOT the already-sent-today gate", () => {
    const early = AEDT_8AM - 60 * 60 * 1000;
    expect(decideSubscriberSend({ nowMs: early, sub: sub(), force: true }).due).toBe(true);
    expect(decideSubscriberSend({ nowMs: early, sub: sub({ last_sent_day: AEDT_DAY }), force: true }).due).toBe(false);
  });
});

describe("digestSubject", () => {
  it("names the story count and date, pluralising correctly", () => {
    expect(digestSubject(18, AEST_8AM, TZ)).toContain("18 stories");
    expect(digestSubject(1, AEST_8AM, TZ)).toContain("1 story");
  });
});

describe("mailer config", () => {
  const full: Partial<Env> = {
    RESEND_API_KEY: "re_" + "a".repeat(30),
    DIGEST_FROM: "digest@example.org",
  };

  it("builds a config from a complete env", () => {
    const cfg = mailerConfig(full as Env);
    expect("error" in cfg).toBe(false);
    if (!("error" in cfg)) {
      expect(cfg.fromAddress).toBe("digest@example.org");
      expect(cfg.fromName).toBe("Headwater"); // default
    }
  });

  it("names exactly what is missing rather than throwing", () => {
    const cfg = mailerConfig({ DIGEST_FROM: "digest@example.org" } as Env);
    expect("error" in cfg && cfg.error).toContain("RESEND_API_KEY");
    expect("error" in cfg && cfg.error).not.toContain("DIGEST_TO");
  });
});

describe("formatFrom", () => {
  it("builds the Resend single-string From header", () => {
    expect(formatFrom("Headwater", "digest@example.org")).toBe('"Headwater" <digest@example.org>');
  });

  it("escapes a quote or backslash in the display name, which would break the header", () => {
    expect(formatFrom('Simon "Si" H', "d@x.com")).toBe('"Simon \\"Si\\" H" <d@x.com>');
  });

  it("falls back to the bare address when there is no name", () => {
    expect(formatFrom("", "d@x.com")).toBe("d@x.com");
  });
});

describe("digest config validation", () => {
  // Core config is present throughout, so `configOk` reflects the DIGEST_* checks and nothing else.
  const CORE = {
    POSTING_ENABLED: "true",
    WEBHOOK_SHARED_SECRET: "x".repeat(20),
    REPLAY_KEY: "y".repeat(20),
    SLACK_BOT_TOKEN: "xoxb-" + "z".repeat(20),
    SLACK_DEFAULT_CHANNEL: "C0123ABCD",
    SLACK_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
  };

  const on = {
    ...CORE,
    DIGEST_ENABLED: "true",
    RESEND_API_KEY: "re_" + "a".repeat(30),
    DIGEST_FROM: "digest@example.org",
  } as Env;

  const issuesFor = (env: Partial<Env>) => summarizeConfig(validateConfig(env as Env)).issues.map((i) => i.name);

  it("passes a fully configured digest", () => {
    expect(issuesFor(on)).toEqual([]);
  });

  it("stays quiet — and configOk stays true — when the digest is simply unconfigured", () => {
    // The ingestion pipeline runs fine without any digest config; it must not fail /health.
    const env = CORE as Env;
    const s = summarizeConfig(validateConfig(env));
    expect(s.ok).toBe(true);
    expect(s.issues.map((i) => i.name)).not.toContain("DIGEST_FROM");
  });

  it("catches a non-Resend key pasted into RESEND_API_KEY", () => {
    // e.g. a Cloudflare API token, which looks plausible but will 401 on every send.
    expect(issuesFor({ ...on, RESEND_API_KEY: "v1.0-abcdef0123456789abcdef" })).toContain("RESEND_API_KEY");
    expect(issuesFor({ ...on, RESEND_API_KEY: "re_short" })).toContain("RESEND_API_KEY");
  });

  it("catches a non-address in DIGEST_FROM", () => {
    expect(issuesFor({ ...on, DIGEST_FROM: "Headwater Daily" })).toContain("DIGEST_FROM");
  });

  it("no longer wants a DIGEST_TO — recipients live in D1", () => {
    expect(issuesFor(on)).not.toContain("DIGEST_TO");
  });

  it("only warns about a missing SLACK_SIGNING_SECRET — the feed doesn't need it", () => {
    const s = summarizeConfig(validateConfig({ ...on, SLACK_SIGNING_SECRET: undefined } as Env));
    expect(s.ok).toBe(true);
    expect(s.issues.find((i) => i.name === "SLACK_SIGNING_SECRET")!.severity).toBe("warn");
    expect(issuesFor({ ...on, SLACK_SIGNING_SECRET: "not-hex" })).toContain("SLACK_SIGNING_SECRET");
  });

  it("downgrades missing digest config to a warning while DIGEST_ENABLED is not true", () => {
    // Half-configured but switched off: surfaced, but configOk must stay true.
    const s = summarizeConfig(validateConfig({ ...on, DIGEST_ENABLED: "false", DIGEST_FROM: undefined } as Env));
    expect(s.issues.map((i) => i.name)).toContain("DIGEST_FROM");
    expect(s.issues.find((i) => i.name === "DIGEST_FROM")!.severity).toBe("warn");
    expect(s.ok).toBe(true);
  });

  it("makes the same gap an error once the digest is switched on", () => {
    const s = summarizeConfig(validateConfig({ ...on, DIGEST_FROM: undefined } as Env));
    expect(s.issues.find((i) => i.name === "DIGEST_FROM")!.severity).toBe("error");
    expect(s.ok).toBe(false);
  });
});
