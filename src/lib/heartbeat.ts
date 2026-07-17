import type { Env } from "@/env";
import { EventLog } from "@/lib/store/eventLog";
import { OpsState } from "@/lib/store/opsState";
import { postText } from "@/lib/slack/post";
import { fmtReceivedApprox } from "@/lib/slack/format";

const HOUR_MS = 60 * 60 * 1000;
/** ops_state key holding the epoch-ms of the last stall alert we posted (for re-alert throttling). */
export const LAST_ALERT_KEY = "heartbeat:last_stall_alert_at";

const DEFAULT_MAX_SILENCE_HOURS = 24;
const DEFAULT_REALERT_HOURS = 6;

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
  const thresholdHours = numEnv(env.HEARTBEAT_MAX_SILENCE_HOURS, DEFAULT_MAX_SILENCE_HOURS);
  const reAlertHours = numEnv(env.HEARTBEAT_REALERT_HOURS, DEFAULT_REALERT_HOURS);
  const ops = new OpsState(env.DB);

  const latest = await new EventLog(env.DB).latestMentionReceivedAt();
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
    `Check the Meltwater destination URL/token and <https://feed.moofer.com/health|feed.moofer.com/health> (\`configOk\`).`
  );
}
