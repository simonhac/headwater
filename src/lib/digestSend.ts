import type { Env } from "@/env";
import { OpsState } from "@/lib/store/opsState";
import { buildDigest, DIGEST_TZ } from "@/lib/digest";
import { renderDigestEmail, renderDigestText } from "@/ui/email";
import { mailerConfig, sendEmail } from "@/lib/mailer";

/**
 * The daily digest send.
 *
 * Structured like `src/lib/heartbeat.ts`: a pure `decideDigestSend` (no IO, fully unit-testable with
 * an injected clock) plus `runDigestSend` that does the D1 read, the render and the API call.
 *
 * TIMEZONE. Cron Triggers fire on UTC, but the send is pinned to 8am *Melbourne*, which is UTC+10
 * in winter (AEST) and UTC+11 over daylight saving (AEDT). A single UTC cron would therefore drift
 * by an hour twice a year. Instead wrangler.jsonc registers BOTH candidate hours (21:00 and 22:00
 * UTC) and this gate lets exactly one of them through — whichever is currently 8am in Melbourne.
 *
 * SEND-ONCE. `ops_state` records the Melbourne calendar day last sent. A Cloudflare cron retry, a
 * manual /admin/digest-send, or both cron hours somehow passing can then never double-send.
 */

/** ops_state key holding the Melbourne calendar day (YYYY-MM-DD) of the last digest sent. */
export const DIGEST_LAST_SENT_KEY = "digest:last_sent_day";
/** Local hour the digest goes out. */
export const DIGEST_SEND_HOUR = 8;
/** How far back each digest looks. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hour (0-23) at `ms` in `timeZone`. h23 so midnight is 0, not 24. */
export function zonedHour(ms: number, timeZone: string): number {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return Number(s);
}

/** Calendar day at `ms` in `timeZone`, as YYYY-MM-DD (en-CA formats in that order). */
export function zonedDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

export type SkipReason = "disabled" | "wrong_hour" | "already_sent_today";

export interface SendDecision {
  shouldSend: boolean;
  reason?: SkipReason;
  /** Melbourne calendar day this run represents. */
  day: string;
  hour: number;
}

/**
 * Pure: should this invocation send? `force` (the admin route) bypasses the hour gate but NOT the
 * already-sent-today gate — testing must never be able to double-send a real digest. Use the admin
 * route's dry-run to preview without sending.
 */
export function decideDigestSend(p: {
  nowMs: number;
  timeZone: string;
  lastSentDay: string | null;
  enabled: boolean;
  force?: boolean;
}): SendDecision {
  const { nowMs, timeZone, lastSentDay, enabled, force } = p;
  const day = zonedDay(nowMs, timeZone);
  const hour = zonedHour(nowMs, timeZone);

  if (!enabled) return { shouldSend: false, reason: "disabled", day, hour };
  if (lastSentDay === day) return { shouldSend: false, reason: "already_sent_today", day, hour };
  if (!force && hour !== DIGEST_SEND_HOUR) return { shouldSend: false, reason: "wrong_hour", day, hour };
  return { shouldSend: true, day, hour };
}

/** Subject line: informative enough to be useful unopened in a notification. */
export function digestSubject(storyCount: number, nowMs: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(
    new Date(nowMs),
  );
  const stories = `${storyCount} ${storyCount === 1 ? "story" : "stories"}`;
  return `Headwater digest — ${stories} · ${date}`;
}

export interface DigestSendResult extends SendDecision {
  storyCount: number;
  /** True only when the mail API accepted the message. */
  sent: boolean;
  /** Set when the window held no stories, so nothing was sent (the day is still marked done). */
  empty?: boolean;
  dryRun?: boolean;
  error?: string;
  /** Resend's message id, for correlating a send with its dashboard entry. */
  messageId?: string;
}

/**
 * Run the daily send. Never throws — it's called from `scheduled()`, where a rejection just retries
 * noisily; every outcome is reported in the returned result and logged by the caller.
 */
export async function runDigestSend(
  env: Env,
  nowMs: number,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DigestSendResult> {
  const ops = new OpsState(env.DB);
  const lastSentDay = await ops.get(DIGEST_LAST_SENT_KEY);
  const decision = decideDigestSend({
    nowMs,
    timeZone: DIGEST_TZ,
    lastSentDay,
    // A dry run is a preview, so it ignores the master switch; a real send never does.
    enabled: opts.dryRun ? true : env.DIGEST_ENABLED === "true",
    force: opts.force,
  });

  const base: DigestSendResult = { ...decision, storyCount: 0, sent: false };
  if (!decision.shouldSend) return base;

  const digest = await buildDigest(env, nowMs - DIGEST_WINDOW_MS, nowMs);
  const storyCount = digest.storyCount;

  // Nothing in the window: send no mail, but mark the day done so a retry doesn't keep rechecking.
  if (storyCount === 0) {
    if (!opts.dryRun) await ops.set(DIGEST_LAST_SENT_KEY, decision.day, nowMs);
    return { ...base, storyCount, empty: true };
  }

  const cfg = mailerConfig(env);
  if ("error" in cfg) return { ...base, storyCount, error: `not configured — ${cfg.error}` };

  const html = renderDigestEmail(digest, { timeZone: DIGEST_TZ, slackUrl: env.DIGEST_SLACK_URL });
  const text = renderDigestText(digest, { timeZone: DIGEST_TZ });
  const subject = digestSubject(storyCount, nowMs, DIGEST_TZ);

  if (opts.dryRun) return { ...base, storyCount, dryRun: true };

  // Keyed on the local day: a retry after a successful send but a failed marker write cannot
  // deliver a second copy.
  const res = await sendEmail(cfg, { subject, html, text, idempotencyKey: `headwater-digest-${decision.day}` });
  if (!res.ok) return { ...base, storyCount, error: res.error };

  // Mark the day only after the API accepted it, so a failed send retries on the next tick.
  await ops.set(DIGEST_LAST_SENT_KEY, decision.day, nowMs);
  return { ...base, storyCount, sent: true, messageId: res.id };
}
