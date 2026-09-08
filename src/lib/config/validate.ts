import { feedConfig } from "@/config/feed.config";
import type { Env } from "@/env";
import type { Routing } from "@/lib/routing";

/** A single config check. `detail` is safe to surface publicly — it NEVER contains a secret value. */
export interface ConfigCheck {
  /** The env var this check concerns. */
  name: string;
  /** True when the value is present and well-formed. */
  ok: boolean;
  /** "error" fails `configOk`; "warn" is advisory. */
  severity: "error" | "warn";
  /** Human-readable reason when not ok (no secret values). */
  detail?: string;
}

/** A Slack channel: an id (C/G/D…) or a #name. A bare name without '#' won't resolve. */
export const CHANNEL_RE = /^([CGD][A-Z0-9]{6,}|#[\w-]+)$/;

/** URL scheme, whitespace, or slashes in a value that is supposed to be a bare path/query token. */
const TOKEN_CONTAMINATION = /:\/\/|\s|\//;

/** Bare tokens (WEBHOOK_SHARED_SECRET, REPLAY_KEY): a guess-resistant string, not a URL/path. */
function tokenCheck(name: string, val: string | undefined, min = 16): ConfigCheck {
  if (!val) return { name, ok: false, severity: "error", detail: "missing" };
  // The classic footgun: pasting the whole webhook URL instead of just the token — this value is
  // matched against the URL's *path segment*, so a URL/slash/space here silently 403s every delivery.
  if (TOKEN_CONTAMINATION.test(val)) {
    return { name, ok: false, severity: "error", detail: "expected a bare token but found a URL, slash, or whitespace" };
  }
  if (val.length < min) {
    return { name, ok: false, severity: "warn", detail: `only ${val.length} chars; use ≥${min} for a guess-resistant token` };
  }
  return { name, ok: true, severity: "error" };
}

/**
 * Format-validate the runtime env. Catches *misshapen* config — e.g. WEBHOOK_SHARED_SECRET pasted as
 * a full URL instead of the path token — which otherwise 403s every Meltwater delivery with no error.
 * It cannot catch a *well-formed but wrong* value (a token that simply doesn't match Meltwater's) —
 * that failure mode is covered by the ingestion heartbeat, not here. Returns names + reasons only,
 * never secret values, so the result is safe to expose.
 */
export function validateConfig(env: Env, routing?: Routing): ConfigCheck[] {
  const checks: ConfigCheck[] = [
    tokenCheck("WEBHOOK_SHARED_SECRET", env.WEBHOOK_SHARED_SECRET),
    tokenCheck("REPLAY_KEY", env.REPLAY_KEY),
  ];

  // Slack bot token: xoxb-… (a webhook URL or user/app token won't authorize chat.postMessage).
  const bot = env.SLACK_BOT_TOKEN;
  checks.push({
    name: "SLACK_BOT_TOKEN",
    ok: !!bot && bot.startsWith("xoxb-") && bot.length > 20,
    severity: "error",
    detail: !bot ? "missing" : !bot.startsWith("xoxb-") ? "should be a bot token starting with 'xoxb-'" : bot.length <= 20 ? "implausibly short for a bot token" : undefined,
  });

  // Slack channel: an id (C/G/D…) or a #name. A bare name without '#' won't resolve.
  const ch = env.SLACK_DEFAULT_CHANNEL;
  checks.push({
    name: "SLACK_DEFAULT_CHANNEL",
    ok: !!ch && CHANNEL_RE.test(ch),
    severity: "error",
    detail: ch ? "expected a channel id (e.g. C0123ABCD) or #channel-name" : "missing",
  });

  // POSTING_ENABLED gate is a strict `=== "true"`, so anything else silently pauses posting.
  const pe = env.POSTING_ENABLED;
  checks.push({
    name: "POSTING_ENABLED",
    ok: pe === "true" || pe === "false",
    severity: "warn",
    detail: pe === "true" || pe === "false" ? undefined : `is ${JSON.stringify(pe)}; only the exact string "true" enables posting`,
  });

  // Brief→channel routing (ops_state `routing`, edited at /inspect/routing). Details name brief ids
  // and counts only — never a channel id, which is treated as a secret like SLACK_DEFAULT_CHANNEL.
  if (routing) {
    const known = new Set<string>([...feedConfig.briefs.map((b) => b.id), "default"]);
    const entries = Object.entries(routing.briefs);
    const badChannels = entries.filter(([, chans]) => chans.some((c) => !CHANNEL_RE.test(c))).map(([id]) => id);
    const staleBriefs = entries.filter(([id]) => !known.has(id)).map(([id]) => id);
    checks.push({
      name: "routing",
      ok: badChannels.length === 0,
      severity: "error",
      detail: badChannels.length ? `malformed channel id for brief(s): ${badChannels.join(", ")}` : undefined,
    });
    // A muted brief posts nowhere. That's a legitimate setting, but it's also the one state you can
    // reach with a stray click, and its symptom (a quiet channel) looks exactly like a dead feed —
    // so surface it on /health rather than leaving it to be discovered.
    const mutedBriefs = entries.filter(([, chans]) => chans.length === 0).map(([id]) => id);
    if (mutedBriefs.length) {
      checks.push({
        name: "routing.muted",
        ok: false,
        severity: "warn",
        detail: `brief(s) routed to no channel, so they post nowhere: ${mutedBriefs.join(", ")}`,
      });
    }
    if (staleBriefs.length) {
      checks.push({
        name: "routing.briefs",
        ok: false,
        severity: "warn",
        detail: `routed brief id(s) no longer in feed.config.ts: ${staleBriefs.join(", ")}`,
      });
    }
  }

  checks.push(...digestChecks(env));

  return checks;
}

/** Deliberately loose: enough to catch a name or a URL pasted into an address field. */
const EMAIL_ISH = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/**
 * Daily digest email config. These are only *errors* when DIGEST_ENABLED is "true" — an unconfigured
 * digest must not flip `/health`'s `configOk` false and mask a real problem in the ingestion
 * pipeline, which runs perfectly well without any of this.
 */
function digestChecks(env: Env): ConfigCheck[] {
  const de = env.DIGEST_ENABLED;
  const on = de === "true";
  const sev: "error" | "warn" = on ? "error" : "warn";
  const checks: ConfigCheck[] = [
    {
      name: "DIGEST_ENABLED",
      ok: de === undefined || de === "true" || de === "false",
      severity: "warn",
      detail:
        de === undefined || de === "true" || de === "false"
          ? undefined
          : `is ${JSON.stringify(de)}; only the exact string "true" enables the daily send`,
    },
  ];

  // Below here: only worth reporting once someone has started configuring the digest.
  if (!on && !env.RESEND_API_KEY && !env.DIGEST_FROM && !env.DIGEST_TO) return checks;

  // Resend keys are `re_…`. The common mistakes are pasting a Cloudflare token or a dashboard URL.
  const key = env.RESEND_API_KEY;
  checks.push({
    name: "RESEND_API_KEY",
    ok: !!key && key.startsWith("re_") && key.length >= 20,
    severity: sev,
    detail: !key
      ? "missing"
      : !key.startsWith("re_")
        ? "expected a Resend API key starting with 're_'"
        : key.length < 20
          ? "implausibly short for a Resend API key"
          : undefined,
  });

  // The sending domain must be verified in Resend. A well-formed address on an UNVERIFIED domain is
  // the likeliest failure here, and it can only be caught at send time — so this checks shape only.
  const from = env.DIGEST_FROM;
  checks.push({
    name: "DIGEST_FROM",
    ok: !!from && EMAIL_ISH.test(from),
    severity: sev,
    detail: !from ? "missing" : EMAIL_ISH.test(from) ? undefined : "expected a bare email address on a Resend-verified domain",
  });

  const to = env.DIGEST_TO;
  const recipients = (to ?? "").split(/[,\s]+/).filter((s) => s.includes("@"));
  checks.push({
    name: "DIGEST_TO",
    ok: recipients.length > 0 && recipients.every((r) => EMAIL_ISH.test(r)),
    severity: sev,
    detail: !to ? "missing" : recipients.length === 0 ? "no address containing '@'" : recipients.every((r) => EMAIL_ISH.test(r)) ? undefined : "one or more recipients are not valid addresses",
  });

  if (env.DIGEST_REPLY_TO && !EMAIL_ISH.test(env.DIGEST_REPLY_TO)) {
    checks.push({ name: "DIGEST_REPLY_TO", ok: false, severity: "warn", detail: "not a valid email address" });
  }

  return checks;
}


/** Roll checks into a public-safe summary: `ok` is false iff any error-severity check failed. */
export function summarizeConfig(checks: ConfigCheck[]): {
  ok: boolean;
  issues: { name: string; severity: "error" | "warn"; detail?: string }[];
} {
  const issues = checks.filter((c) => !c.ok).map(({ name, severity, detail }) => ({ name, severity, detail }));
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
