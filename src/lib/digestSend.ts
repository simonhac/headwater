import type { Env } from "@/env";
import { SubscriberStore, type Subscriber } from "@/lib/store/subscribers";
import { buildDigest } from "@/lib/digest";
import { renderDigestEmail, renderDigestText } from "@/ui/email";
import { mailerConfig, sendEmail } from "@/lib/mailer";

/**
 * The daily digest send — one email per subscriber, at the local time each chose from Slack
 * (`/digest subscribe 7:30`; src/lib/slack/commands.ts).
 *
 * Structured like `src/lib/heartbeat.ts`: a pure `decideSubscriberSend` (no IO, fully unit-testable
 * with an injected clock) plus `runDigestSend` that does the D1 reads, the render and the API calls.
 *
 * TIMEZONE. The quarter-hour cron fires on UTC every 15 minutes, which covers every 15-minute slot in
 * every zone; each subscriber's local day + minute-of-day is read with Intl, so daylight saving is
 * handled per zone without any offset arithmetic here.
 *
 * CATCH-UP. A subscriber is due once their local clock has *passed* their chosen time and they have
 * not been sent today (`>=`, not `===`). A late cron tick, an outage or a DST gap then delivers late
 * rather than never. The subscribe handler pre-marks today when the chosen time has already gone by,
 * so a fresh subscription never fires immediately.
 *
 * SEND-ONCE. `digest_subscribers.last_sent_day` records the subscriber's local calendar day last
 * sent, written only after the mail API accepts the message. Resend's Idempotency-Key backstops that.
 */

/** How far back each digest looks. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default local send time: 08:00. */
export const DEFAULT_SEND_MINUTE = 8 * 60;
/** Send-time granularity, matching the quarter-hour cron in wrangler.jsonc. */
export const SLOT_MINUTES = 15;

/** Calendar day at `ms` in `timeZone`, as YYYY-MM-DD (en-CA formats in that order). */
export function zonedDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

/** Minutes after local midnight at `ms` in `timeZone`. h23 so midnight is 0, not 24. */
export function zonedMinuteOfDay(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export type SkipReason = "already_sent_today" | "not_yet";

export interface SubscriberDecision {
  due: boolean;
  reason?: SkipReason;
  /** Subscriber-local calendar day this run represents. */
  day: string;
  /** Subscriber-local minutes after midnight. */
  minute: number;
}

/**
 * Pure: is this subscriber due now? `force` (the admin route) bypasses the time-of-day gate but NOT
 * the already-sent-today gate — testing must never be able to double-send a real digest.
 */
export function decideSubscriberSend(p: {
  nowMs: number;
  sub: Pick<Subscriber, "time_zone" | "send_minute" | "last_sent_day">;
  force?: boolean;
}): SubscriberDecision {
  const { nowMs, sub, force } = p;
  const day = zonedDay(nowMs, sub.time_zone);
  const minute = zonedMinuteOfDay(nowMs, sub.time_zone);
  if (sub.last_sent_day === day) return { due: false, reason: "already_sent_today", day, minute };
  if (!force && minute < sub.send_minute) return { due: false, reason: "not_yet", day, minute };
  return { due: true, day, minute };
}

/** Subject line: informative enough to be useful unopened in a notification. */
export function digestSubject(storyCount: number, nowMs: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(
    new Date(nowMs),
  );
  const stories = `${storyCount} ${storyCount === 1 ? "story" : "stories"}`;
  return `Headwater digest — ${stories} · ${date}`;
}

export interface SubscriberSendResult {
  userId: string;
  day: string;
  status: "sent" | "empty" | "dry_run" | "failed";
  error?: string;
  /** Resend's message id, for correlating a send with its dashboard entry. */
  messageId?: string;
}

export interface DigestSendResult {
  /** All subscribers on file. */
  candidates: number;
  /** How many were due this run. */
  due: number;
  /** Mail API accepted. */
  sent: number;
  failed: number;
  storyCount: number;
  /** Set when subscribers were due but the window held no stories (they are still marked done). */
  empty?: boolean;
  dryRun?: boolean;
  disabled?: boolean;
  /** Run-level problem (e.g. mailer not configured) that stopped every send. */
  error?: string;
  results: SubscriberSendResult[];
}

/**
 * Run the send for everyone currently due. Never throws — it's called from `scheduled()`, where a
 * rejection just retries noisily; every outcome is reported in the returned result and logged by
 * the caller.
 */
export async function runDigestSend(
  env: Env,
  nowMs: number,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DigestSendResult> {
  const base: DigestSendResult = { candidates: 0, due: 0, sent: 0, failed: 0, storyCount: 0, results: [] };
  // A dry run is a preview, so it ignores the master switch; a real send never does.
  if (!opts.dryRun && env.DIGEST_ENABLED !== "true") return { ...base, disabled: true };

  const store = new SubscriberStore(env.DB);
  const subs = await store.all();
  base.candidates = subs.length;

  const due = subs
    .map((sub) => ({ sub, decision: decideSubscriberSend({ nowMs, sub, force: opts.force }) }))
    .filter((d) => d.decision.due);
  base.due = due.length;
  if (!due.length) return base;

  // One D1 read for the run — everyone due at this tick shares the same 24h window.
  const digest = await buildDigest(env, nowMs - DIGEST_WINDOW_MS, nowMs);
  const storyCount = digest.storyCount;
  base.storyCount = storyCount;

  // Nothing in the window: send no mail, but mark the day done so a retry doesn't keep rechecking.
  if (storyCount === 0) {
    for (const { sub, decision } of due) {
      if (!opts.dryRun) await store.markSent(sub.slack_user_id, decision.day, nowMs);
      base.results.push({ userId: sub.slack_user_id, day: decision.day, status: opts.dryRun ? "dry_run" : "empty" });
    }
    return { ...base, empty: true, dryRun: opts.dryRun || undefined };
  }

  const cfg = mailerConfig(env);
  if ("error" in cfg) return { ...base, error: `not configured — ${cfg.error}` };

  // Render once per distinct zone (the date labels depend on it), not once per subscriber.
  const rendered = new Map<string, { html: string; text: string; subject: string }>();
  const renderFor = (timeZone: string) => {
    let r = rendered.get(timeZone);
    if (!r) {
      r = {
        html: renderDigestEmail(digest, { timeZone, slackUrl: env.DIGEST_SLACK_URL }),
        text: renderDigestText(digest, { timeZone }),
        subject: digestSubject(storyCount, nowMs, timeZone),
      };
      rendered.set(timeZone, r);
    }
    return r;
  };

  for (const { sub, decision } of due) {
    if (opts.dryRun) {
      base.results.push({ userId: sub.slack_user_id, day: decision.day, status: "dry_run" });
      continue;
    }
    const r = renderFor(sub.time_zone);
    // Keyed on user + local day + slot: a retry after a successful send but a failed marker write
    // cannot deliver a second copy, while moving the time later the same day still sends.
    const res = await sendEmail(cfg, {
      to: [sub.email],
      subject: r.subject,
      html: r.html,
      text: r.text,
      idempotencyKey: `headwater-digest-${sub.slack_user_id}-${decision.day}-${sub.send_minute}`,
    });
    if (!res.ok) {
      base.failed++;
      base.results.push({ userId: sub.slack_user_id, day: decision.day, status: "failed", error: res.error });
      continue;
    }
    // Mark the day only after the API accepted it, so a failed send retries on the next tick.
    await store.markSent(sub.slack_user_id, decision.day, nowMs);
    base.sent++;
    base.results.push({ userId: sub.slack_user_id, day: decision.day, status: "sent", messageId: res.id });
  }

  return { ...base, dryRun: opts.dryRun || undefined };
}
