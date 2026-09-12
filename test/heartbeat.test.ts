import { describe, it, expect } from "vitest";
import { decideHeartbeat, stallThresholdHours, WEEKDAY_MAX_SILENCE_HOURS, WEEKEND_MAX_SILENCE_HOURS } from "@/lib/heartbeat";

const H = 60 * 60 * 1000;
const NOW = 1_783_600_000_000;
// Defaults mirror runHeartbeat: 3h silence threshold, 6h re-alert window.
const base = { now: NOW, thresholdHours: 3, reAlertHours: 6, lastAlertAt: null as number | null };

describe("decideHeartbeat", () => {
  it("fresh ingestion is healthy and does not alert", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: true, shouldAlert: false, suppressed: false });
    expect(d.ageHours).toBeCloseTo(1);
  });

  it("age exactly at the threshold is still healthy (<=)", () => {
    expect(decideHeartbeat({ ...base, latest: NOW - 3 * H }).healthy).toBe(true);
  });

  it("a stall past the threshold with no prior alert fires an alert", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 5 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: true, suppressed: false });
    expect(d.ageHours).toBeCloseTo(5);
  });

  it("a stall is suppressed while a prior alert is inside the re-alert window", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 5 * H, lastAlertAt: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: false, suppressed: true });
  });

  it("a stall re-alerts once the re-alert window has elapsed", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 12 * H, lastAlertAt: NOW - 7 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: true, suppressed: false });
  });

  it("no events ever recorded counts as a stall (age null) and alerts", () => {
    const d = decideHeartbeat({ ...base, latest: null });
    expect(d).toMatchObject({ healthy: false, ageHours: null, shouldAlert: true });
  });

  it("no events ever, but within a prior alert window → suppressed", () => {
    const d = decideHeartbeat({ ...base, latest: null, lastAlertAt: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: false, ageHours: null, shouldAlert: false, suppressed: true });
  });
});

// The threshold is time-of-week aware because the measured gaps are: over 66 days of production
// traffic (2,618 mentions), every quiet spell of 10h or more fell on a Sat/Sun, the weekday maximum
// was 8.8h and the weekend maximum 20.3h. A flat 24h therefore cost ~28h to notice a real stall
// while sitting only ~3.7h above ordinary weekend quiet.
describe("stallThresholdHours", () => {
  it("is tighter on a weekday than at the weekend", () => {
    // Tue 14 July 2026, 12:00 Melbourne (the day of the worst weekday gap on record, 8.8h).
    expect(stallThresholdHours(Date.UTC(2026, 6, 14, 2, 0))).toBe(WEEKDAY_MAX_SILENCE_HOURS);
    // Sat 25 July 2026, 14:00 Melbourne — inside the 20.3h weekend gap that sets the tail.
    expect(stallThresholdHours(Date.UTC(2026, 6, 25, 4, 0))).toBe(WEEKEND_MAX_SILENCE_HOURS);
  });

  it("switches on the LOCAL day, not the UTC one", () => {
    // 14:30 UTC Friday is already Sat 00:30 in Melbourne: a UTC-based rule would get this wrong
    // every week, and get it wrong precisely when the feed goes quiet.
    expect(stallThresholdHours(Date.UTC(2026, 6, 24, 13, 30))).toBe(WEEKDAY_MAX_SILENCE_HOURS); // Fri 23:30
    expect(stallThresholdHours(Date.UTC(2026, 6, 24, 14, 30))).toBe(WEEKEND_MAX_SILENCE_HOURS); // Sat 00:30
    expect(stallThresholdHours(Date.UTC(2026, 6, 26, 13, 30))).toBe(WEEKEND_MAX_SILENCE_HOURS); // Sun 23:30
    expect(stallThresholdHours(Date.UTC(2026, 6, 26, 14, 30))).toBe(WEEKDAY_MAX_SILENCE_HOURS); // Mon 00:30
  });

  it("honours daylight saving, where the same UTC hour falls on a different local day", () => {
    // January is AEDT (+11), July AEST (+10). 13:30 UTC on a Friday is Saturday in summer and still
    // Friday in winter — so a fixed offset would mis-classify half the year.
    expect(stallThresholdHours(Date.UTC(2026, 0, 9, 12, 30))).toBe(WEEKDAY_MAX_SILENCE_HOURS); // Fri 23:30 AEDT
    expect(stallThresholdHours(Date.UTC(2026, 0, 9, 13, 30))).toBe(WEEKEND_MAX_SILENCE_HOURS); // Sat 00:30 AEDT
    expect(stallThresholdHours(Date.UTC(2026, 6, 24, 13, 30))).toBe(WEEKDAY_MAX_SILENCE_HOURS); // Fri 23:30 AEST
  });
});
