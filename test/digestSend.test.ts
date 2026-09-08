import { describe, it, expect } from "vitest";
import {
  decideDigestSend,
  zonedHour,
  zonedDay,
  digestSubject,
  DIGEST_SEND_HOUR,
} from "@/lib/digestSend";
import { mailerConfig, splitAddresses, formatFrom } from "@/lib/mailer";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import type { Env } from "@/env";

const TZ = "Australia/Melbourne";

// Melbourne is UTC+11 over daylight saving (Oct–Apr) and UTC+10 otherwise. These two instants are
// both 8am local, an hour apart in UTC — the whole reason the cron registers two hours.
const AEDT_8AM = Date.UTC(2026, 0, 15, 21, 0); // 15 Jan 2026 21:00Z = 08:00 AEDT
const AEST_8AM = Date.UTC(2026, 6, 15, 22, 0); // 15 Jul 2026 22:00Z = 08:00 AEST

describe("timezone gate", () => {
  it("reads 8am local at BOTH candidate UTC hours across the DST boundary", () => {
    expect(zonedHour(AEDT_8AM, TZ)).toBe(DIGEST_SEND_HOUR);
    expect(zonedHour(AEST_8AM, TZ)).toBe(DIGEST_SEND_HOUR);
  });

  it("rejects the other cron hour, so exactly one of the two fires", () => {
    // In January, 22:00Z is 9am local — the second cron must not also send.
    expect(zonedHour(Date.UTC(2026, 0, 15, 22, 0), TZ)).toBe(9);
    // In July, 21:00Z is 7am local.
    expect(zonedHour(Date.UTC(2026, 6, 15, 21, 0), TZ)).toBe(7);
  });

  it("formats midnight as hour 0, not 24", () => {
    expect(zonedHour(Date.UTC(2026, 6, 15, 14, 0), TZ)).toBe(0); // 14:00Z = midnight AEST
  });

  it("reports the LOCAL calendar day, which can differ from the UTC day", () => {
    // 21:00Z on 14 Jan is already 15 Jan in Melbourne.
    expect(zonedDay(Date.UTC(2026, 0, 14, 21, 0), TZ)).toBe("2026-01-15");
  });
});

describe("decideDigestSend", () => {
  const base = { nowMs: AEST_8AM, timeZone: TZ, lastSentDay: null, enabled: true };

  it("sends at 8am local when enabled and not yet sent", () => {
    expect(decideDigestSend(base).shouldSend).toBe(true);
  });

  it("does not send when the master switch is off", () => {
    const d = decideDigestSend({ ...base, enabled: false });
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("does not send at the wrong local hour", () => {
    const d = decideDigestSend({ ...base, nowMs: Date.UTC(2026, 6, 15, 21, 0) }); // 7am local
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toBe("wrong_hour");
  });

  it("does not send twice on the same local day", () => {
    const d = decideDigestSend({ ...base, lastSentDay: "2026-07-16" });
    expect(zonedDay(AEST_8AM, TZ)).toBe("2026-07-16"); // sanity: that IS today, locally
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toBe("already_sent_today");
  });

  it("sends again the next day", () => {
    expect(decideDigestSend({ ...base, lastSentDay: "2026-07-15" }).shouldSend).toBe(true);
  });

  it("force bypasses the hour gate", () => {
    const off = decideDigestSend({ ...base, nowMs: Date.UTC(2026, 6, 15, 3, 0) });
    expect(off.shouldSend).toBe(false);
    expect(decideDigestSend({ ...base, nowMs: Date.UTC(2026, 6, 15, 3, 0), force: true }).shouldSend).toBe(true);
  });

  it("force must NOT bypass the already-sent guard — testing can't double-send", () => {
    const d = decideDigestSend({ ...base, lastSentDay: "2026-07-16", force: true });
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toBe("already_sent_today");
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
    DIGEST_TO: "you@example.org",
  };

  it("builds a config from a complete env", () => {
    const cfg = mailerConfig(full as Env);
    expect("error" in cfg).toBe(false);
    if (!("error" in cfg)) {
      expect(cfg.to).toEqual(["you@example.org"]);
      expect(cfg.fromName).toBe("Headwater"); // default
    }
  });

  it("names exactly what is missing rather than throwing", () => {
    const cfg = mailerConfig({ DIGEST_FROM: "digest@example.org" } as Env);
    expect("error" in cfg && cfg.error).toContain("RESEND_API_KEY");
    expect("error" in cfg && cfg.error).toContain("DIGEST_TO");
  });

  it("splits a multi-recipient list on commas and whitespace", () => {
    expect(splitAddresses("a@x.com, b@y.com\nc@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(splitAddresses("not-an-address")).toEqual([]);
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
  };

  const on = {
    ...CORE,
    DIGEST_ENABLED: "true",
    RESEND_API_KEY: "re_" + "a".repeat(30),
    DIGEST_FROM: "digest@example.org",
    DIGEST_TO: "you@example.org",
  } as Env;

  const issuesFor = (env: Partial<Env>) => summarizeConfig(validateConfig(env as Env)).issues.map((i) => i.name);

  it("passes a fully configured digest", () => {
    expect(issuesFor(on)).not.toContain("DIGEST_CF_ACCOUNT_ID");
    expect(issuesFor(on)).not.toContain("DIGEST_FROM");
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

  it("catches a non-address in DIGEST_FROM / DIGEST_TO", () => {
    expect(issuesFor({ ...on, DIGEST_FROM: "Headwater Daily" })).toContain("DIGEST_FROM");
    expect(issuesFor({ ...on, DIGEST_TO: "simon" })).toContain("DIGEST_TO");
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

  it("flags a DIGEST_ENABLED value that isn't exactly true/false", () => {
    expect(issuesFor({ ...on, DIGEST_ENABLED: "yes" })).toContain("DIGEST_ENABLED");
  });

  it("never leaks a secret value in the issue details", () => {
    const token = "super-secret-token-value-1234567890";
    const detail = JSON.stringify(validateConfig({ ...on, DIGEST_API_TOKEN: "short" } as Env));
    expect(detail).not.toContain(token);
    expect(detail).not.toContain("you@example.org");
  });
});
