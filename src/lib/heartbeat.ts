import type { Env } from "@/env";
import { DIGEST_TZ } from "@/lib/digest";
import { EventLog } from "@/lib/store/eventLog";
import { OpsState } from "@/lib/store/opsState";
import { postText } from "@/lib/slack/post";
import { fmtReceivedApprox } from "@/lib/slack/format";

const HOUR_MS = 60 * 60 * 1000;
/** ops_state key holding the epoch-ms of the last stall alert we posted (for re-alert throttling). */
export const LAST_ALERT_KEY = "heartbeat:last_stall_alert_at";

/**
 * How long a quiet feed is tolerated, by LOCAL day of week — the single definition of "stalled",
 * shared by the Slack alert and `/health` so the two can never drift apart.
 *
 * Measured, not guessed (2,618 processed mentions over 66 days of production D1, 2026-09-12):
 * mean gap 0.6h; 25 gaps over 6h; every gap of 10h or more fell on a Sat/Sun; weekday maximum
 * 8.8h; weekend maximum 20.3h; and exactly one gap over 24h — the 26-hour outage itself. So a flat
 * 24h sat only ~3.7h above ordinary weekend quiet while costing ~28h to notice a real stall.
 *
 * 16h on a weekday leaves 7.2h of headroom over the worst weekday gap on record and detects a
 * weekday stall in ~16h; the weekend keeps 24h because the observed tail genuinely reaches 20h.
 * Public holidays behave like weekdays here — that is what the headroom is for.
 */
export const WEEKDAY_MAX_SILENCE_HOURS = 16;
export const WEEKEND_MAX_SILENCE_HOURS = 24;
const DEFAULT_REALERT_HOURS = 6;

/** The feed is Australian media, so "weekend" means a Melbourne weekend, not a UTC one. Same zone
 *  as the digest (DIGEST_TZ) — deliberately one string, because two copies drift. */
export const FEED_TZ = DIGEST_TZ;

/** Pure: the silence threshold that applies at `now`, chosen by local day of week. */
export function stallThresholdHours(now: number, timeZone: string = FEED_TZ): number {
  const day = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short" }).format(new Date(now));
  return day === "Sat" || day === "Sun" ? WEEKEND_MAX_SILENCE_HOURS : WEEKDAY_MAX_SILENCE_HOURS;
}

/** The threshold in force, honouring the HEARTBEAT_MAX_SILENCE_HOURS escape hatch: when set it
 *  overrides BOTH days with one flat value (that is how the integration tests pin it to 3h). */
export function maxSilenceHours(env: Env, now: number): number {
  const override = Number(env.HEARTBEAT_MAX_SILENCE_HOURS);
  return Number.isFinite(override) && override > 0 ? override : stallThresholdHours(now);
}

/** Pure decision: given the latest receipt time and last-alert marker, is ingestion healthy and
 * should we alert now? Separated from IO so it can be unit-tested without D1/Slack. */
export interface HeartbeatDecision {
  healthy: boolean;
  /** Hours since the last webhook; null when none have ever been logged. */
  ageHours: number | null;
  /** Post an alert this run. */
  shouldAlert: boolean;
  /** Stalled, but a prior alert is still inside the re-alert window (so we stay quiet). */
  suppressed: boolean;
}

export function decideHeartbeat(p: {
  latest: number | null;
  now: number;
  thresholdHours: number;
  reAlertHours: number;
  lastAlertAt: number | null;
}): HeartbeatDecision {
  const { latest, now, thresholdHours, reAlertHours, lastAlertAt } = p;
  const ageHours = latest === null ? null : (now - latest) / HOUR_MS;
  const healthy = ageHours !== null && ageHours <= thresholdHours;
  if (healthy) return { healthy: true, ageHours, shouldAlert: false, suppressed: false };
  const suppressed = lastAlertAt !== null && now - lastAlertAt < reAlertHours * HOUR_MS;
  return { healthy: false, ageHours, shouldAlert: !suppressed, suppressed };
}

export interface HeartbeatResult extends HeartbeatDecision {
  /** Receipt time (epoch ms) of the newest webhook that parsed into a real mention; null if none. */
  latestMentionAt: number | null;
  thresholdHours: number;
  /** An alert was actually posted to Slack this run. */
  alerted: boolean;
  /** Set when we wanted to alert but the Slack post failed (e.g. no channel / no token). */
  alertError?: string;
}

function numEnv(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Check whether inbound Meltwater webhooks have gone quiet and alert Slack if so. Runs from the cron
 * trigger and the gated `/admin/heartbeat` route. De-duped via `ops_state` so a persistent stall
 * pages at most once per `HEARTBEAT_REALERT_HOURS`; the marker is cleared once ingestion recovers so
 * the next stall alerts promptly. `now` (epoch ms) is injected for testability.
 */
export async function runHeartbeat(env: Env, now: number): Promise<HeartbeatResult> {
  const thresholdHours = maxSilenceHours(env, now);
  const reAlertHours = numEnv(env.HEARTBEAT_REALERT_HOURS, DEFAULT_REALERT_HOURS);
  const ops = new OpsState(env.DB);

  const latest = await new EventLog(env.DB).latestProcessedMentionAt();
  const lastAlertAt = await ops.getNumber(LAST_ALERT_KEY);
  const d = decideHeartbeat({ latest, now, thresholdHours, reAlertHours, lastAlertAt });
  const base: HeartbeatResult = { ...d, latestMentionAt: latest, thresholdHours, alerted: false };

  if (d.healthy) {
    // Recovered (or never stalled): clear any marker so a future stall alerts immediately.
    if (lastAlertAt !== null) await ops.delete(LAST_ALERT_KEY);
    return base;
  }
  if (!d.shouldAlert) return base; // stalled but inside the re-alert window

  const channel = env.SLACK_ALERT_CHANNEL ?? env.SLACK_DEFAULT_CHANNEL ?? "";
  if (!channel) return { ...base, alertError: "no_channel" };

  const res = await postText(env, channel, buildAlertText(latest, d.ageHours, thresholdHours));
  if (!res.ok) return { ...base, alertError: res.error ?? "unknown" };
  await ops.set(LAST_ALERT_KEY, String(now), now);
  return { ...base, alerted: true };
}

function buildAlertText(latest: number | null, ageHours: number | null, thresholdHours: number): string {
  const lastSeen = latest === null ? "none on record" : (fmtReceivedApprox(latest) ?? new Date(latest).toISOString());
  const ageText = ageHours === null ? "ever (no events on record)" : `${ageHours.toFixed(1)}h`;
  return (
    `:warning: *Headwater ingestion stalled* — no Meltwater mention received in ${ageText} ` +
    `(threshold ${thresholdHours}h). Last mention: ${lastSeen}.\n` +
    `Check the Meltwater destination URL/token and the Worker's \`/health\` (\`configOk\`).`
  );
}
