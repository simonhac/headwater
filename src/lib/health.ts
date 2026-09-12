/**
 * The pure half of `GET /health`.
 *
 * headwater is watched by ONE BetterStack keyword monitor on `/health`, which requires a 2xx *and*
 * the literal `"configOk":true`. So any condition that makes this endpoint fail closed is caught in
 * ~6 minutes with no new monitoring resource — roughly 20x faster than a 1-hour heartbeat, which is
 * why the dead-man's-switch pings this replaced were removed rather than kept alongside.
 *
 * The cost of collapsing several alarms into one is that the diagnosis moves out of the alert's
 * NAME and into its BODY. Two things pay that back, and both are load-bearing:
 *   1. every condition stays a separately visible boolean/number in the JSON, and
 *   2. every predicate is pure and unit-tested, so a bug cannot silently narrow coverage.
 *
 * `null` means "no evidence yet", and is deliberately treated as HEALTHY throughout — a marker that
 * has never been written, or an archive with nothing in it. Only a marker that has gone STALE is a
 * fault. The alternative (absent ⇒ unhealthy) would 503 every fresh deployment until the first cron
 * tick, i.e. page on a routine deploy. Staleness, not absence, is the signal.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Events that arrived but never got past `decision = 'logged'` are normally invisible, because
 * reconcile re-processes EVERY event in its 72h window on the quarter-hourly cron — so a dead consumer
 * alone is healed within a tick or two and costs only latency. Surviving three reconcile cycles
 * means the consumer AND the reconcile are both failing, which nothing else would tell us.
 */
export const PROCESSING_STALE_MINUTES = 45;
/** Only look back a day for those: a poison payload from months ago is not today's fault, and the
 *  window is what lets a genuinely stuck event age out instead of pinning the monitor red forever. */
export const PROCESSING_WINDOW_HOURS = 24;
/** Three missed quarter-hourly ticks. That cron carries reconcile (the 72h self-healing net), the
 *  render poke and the digest send, and had no monitoring of any kind before this. */
export const QUARTER_HOURLY_STALE_MINUTES = 45;
/** Tolerates exactly one missed hourly invocation, so a single delayed Cloudflare cron is not a
 *  page — the same tolerance the retired `headwater-hourly` heartbeat carried as 1h period + 1h grace. */
export const HOURLY_STALE_MINUTES = 120;

/**
 * ops_state keys recording that each cron branch RAN. These replace the external dead-man's-switch
 * pings, and are strictly better evidence: writing a marker proves D1 is WRITABLE, where the ping
 * only proved a read succeeded — and `/health` is polled every 180s, where the heartbeat's floor
 * was its own 1h period.
 */
export const HOURLY_TICK_KEY = "cron:last_hourly_at";
export const QUARTER_HOURLY_TICK_KEY = "cron:last_quarter_hourly_at";

/** Everything the checks need from D1, read in one pass. */
export interface HealthGauges {
  /** MAX(received_at) — arrival, unfiltered. */
  lastReceivedAt: number | null;
  /** MAX(received_at) over events that finished processing into a real mention. */
  lastProcessedAt: number | null;
  /** Events received within PROCESSING_WINDOW_HOURS, still `decision='logged'`, older than the grace. */
  unprocessed: number;
  /** Failed/undelivered events older than the reconcile heal window: these will never self-heal. */
  stuckFailures: number;
  /** Epoch-ms of the last hourly tick, and the last quarter-hourly tick. Null = never recorded. */
  hourlyTickAt: number | null;
  quarterHourlyTickAt: number | null;
}

export interface Check {
  ok: boolean;
}
export interface AgeCheck extends Check {
  /** Age of the evidence in minutes, or null when there is none yet. */
  ageMinutes: number | null;
  thresholdMinutes: number;
}

export interface HealthAssessment {
  /** False if ANY check failed — the caller turns this into a 503. */
  ok: boolean;
  checks: {
    // The quarter-hourly cron ran recently.
    quarterHourly: AgeCheck;
    // The hourly cron ran recently.
    hourly: AgeCheck;
    /** Arrivals are being processed (queue consumer + reconcile between them). */
    processing: Check & { unprocessed: number; thresholdMinutes: number };
    /** Mentions are still arriving, against a time-of-week threshold. */
    feed: Check & { ageHours: number | null; thresholdHours: number };
    /** Nothing has failed past the point where reconcile could still heal it. */
    failures: Check & { stuck: number };
  };
}

/** Minutes since `at`, or null when `at` is null. */
function ageMinutes(at: number | null, now: number): number | null {
  return at === null ? null : (now - at) / MINUTE_MS;
}

/** Fresh-enough marker check: absent is healthy (see the module note), stale is not. */
function freshness(at: number | null, now: number, thresholdMinutes: number): AgeCheck {
  const age = ageMinutes(at, now);
  return { ok: age === null || age <= thresholdMinutes, ageMinutes: age, thresholdMinutes };
}

/**
 * Assess every fault `/health` can see. Pure: no D1, no clock, no env — `now` and the gauges are
 * injected, `feedThresholdHours` comes from the shared stall predicate so `/health` and the
 * in-Worker Slack alert can never disagree about what "stalled" means.
 */
export function assessHealth(p: {
  gauges: HealthGauges;
  now: number;
  feedThresholdHours: number;
}): HealthAssessment {
  const { gauges, now, feedThresholdHours } = p;

  const quarterHourly = freshness(gauges.quarterHourlyTickAt, now, QUARTER_HOURLY_STALE_MINUTES);
  const hourly = freshness(gauges.hourlyTickAt, now, HOURLY_STALE_MINUTES);
  const processing = {
    ok: gauges.unprocessed === 0,
    unprocessed: gauges.unprocessed,
    thresholdMinutes: PROCESSING_STALE_MINUTES,
  };
  const feedAgeHours = gauges.lastProcessedAt === null ? null : (now - gauges.lastProcessedAt) / HOUR_MS;
  const feed = {
    ok: feedAgeHours === null || feedAgeHours <= feedThresholdHours,
    ageHours: feedAgeHours,
    thresholdHours: feedThresholdHours,
  };
  const failures = { ok: gauges.stuckFailures === 0, stuck: gauges.stuckFailures };

  const checks = { quarterHourly, hourly, processing, feed, failures };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}
