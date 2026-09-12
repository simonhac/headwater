import { describe, it, expect } from "vitest";
import {
  assessHealth,
  HOURLY_STALE_MINUTES,
  PROCESSING_STALE_MINUTES,
  QUARTER_HOURLY_STALE_MINUTES,
  type HealthGauges,
} from "@/lib/health";

const MIN = 60 * 1000;
const H = 60 * MIN;
const NOW = 1_783_600_000_000;

/** A feed that is working: both crons just ticked, nothing unprocessed, nothing stuck. */
const healthy: HealthGauges = {
  lastReceivedAt: NOW - 20 * MIN,
  lastProcessedAt: NOW - 20 * MIN,
  unprocessed: 0,
  stuckFailures: 0,
  hourlyTickAt: NOW - 10 * MIN,
  quarterHourlyTickAt: NOW - 5 * MIN,
};
const assess = (over: Partial<HealthGauges> = {}, feedThresholdHours = 16) =>
  assessHealth({ gauges: { ...healthy, ...over }, now: NOW, feedThresholdHours });

describe("assessHealth", () => {
  it("passes when every gauge is fresh", () => {
    const a = assess();
    expect(a.ok).toBe(true);
    for (const [name, check] of Object.entries(a.checks)) {
      expect(check.ok, `${name} should be ok`).toBe(true);
    }
  });

  it("fails the whole assessment when any single check fails, and names only that one", () => {
    const a = assess({ stuckFailures: 1 });
    expect(a.ok).toBe(false);
    expect(a.checks.failures).toMatchObject({ ok: false, stuck: 1 });
    // The diagnosis lives in the body, so the other checks must stay individually true.
    expect(a.checks.feed.ok).toBe(true);
    expect(a.checks.hourly.ok).toBe(true);
    expect(a.checks.quarterHourly.ok).toBe(true);
    expect(a.checks.processing.ok).toBe(true);
  });

  describe("cron freshness", () => {
    it("fails when the quarter-hourly marker is stale", () => {
      const a = assess({ quarterHourlyTickAt: NOW - (QUARTER_HOURLY_STALE_MINUTES + 1) * MIN });
      expect(a.ok).toBe(false);
      expect(a.checks.quarterHourly.ok).toBe(false);
      expect(a.checks.quarterHourly.ageMinutes).toBeCloseTo(QUARTER_HOURLY_STALE_MINUTES + 1);
    });

    it("fails when the hourly marker is stale", () => {
      const a = assess({ hourlyTickAt: NOW - (HOURLY_STALE_MINUTES + 1) * MIN });
      expect(a.ok).toBe(false);
      expect(a.checks.hourly.ok).toBe(false);
    });

    it("treats a marker exactly at its threshold as fresh", () => {
      expect(assess({ hourlyTickAt: NOW - HOURLY_STALE_MINUTES * MIN }).checks.hourly.ok).toBe(true);
      expect(
        assess({ quarterHourlyTickAt: NOW - QUARTER_HOURLY_STALE_MINUTES * MIN }).checks.quarterHourly.ok,
      ).toBe(true);
    });

    it("treats a marker that has NEVER been written as healthy, not failed", () => {
      // Absence only happens before the first tick after a fresh database. Failing there would 503
      // every deployment for up to 15 minutes — i.e. page on a routine deploy. Staleness is the
      // signal, not absence.
      const a = assess({ hourlyTickAt: null, quarterHourlyTickAt: null });
      expect(a.ok).toBe(true);
      expect(a.checks.hourly.ageMinutes).toBeNull();
      expect(a.checks.quarterHourly.ageMinutes).toBeNull();
    });
  });

  describe("processing", () => {
    it("fails when events arrived but never got processed", () => {
      const a = assess({ unprocessed: 3 });
      expect(a.ok).toBe(false);
      expect(a.checks.processing).toMatchObject({
        ok: false,
        unprocessed: 3,
        thresholdMinutes: PROCESSING_STALE_MINUTES,
      });
    });

    it("passes on a quiet feed with nothing unprocessed", () => {
      expect(assess({ unprocessed: 0 }).checks.processing.ok).toBe(true);
    });
  });

  describe("feed staleness", () => {
    it("fails once the newest processed mention is past the threshold", () => {
      const a = assess({ lastProcessedAt: NOW - 17 * H }, 16);
      expect(a.ok).toBe(false);
      expect(a.checks.feed).toMatchObject({ ok: false, thresholdHours: 16 });
      expect(a.checks.feed.ageHours).toBeCloseTo(17);
    });

    it("uses the threshold it is given, so a weekend tolerates what a weekday does not", () => {
      const gauges = { lastProcessedAt: NOW - 20 * H };
      expect(assess(gauges, 16).checks.feed.ok).toBe(false);
      expect(assess(gauges, 24).checks.feed.ok).toBe(true);
    });

    it("treats exactly at the threshold as healthy", () => {
      expect(assess({ lastProcessedAt: NOW - 16 * H }, 16).checks.feed.ok).toBe(true);
    });

    it("treats an archive with nothing in it as healthy, reporting a null age", () => {
      const a = assess({ lastProcessedAt: null });
      expect(a.ok).toBe(true);
      expect(a.checks.feed.ageHours).toBeNull();
    });
  });

  it("separates arrival from processing, which is the point of carrying both gauges", () => {
    // Mentions arriving normally while nothing finishes processing: the fault the old single gauge
    // could not distinguish from a silent upstream (both took ~28h to notice).
    const a = assess({ lastReceivedAt: NOW - 2 * MIN, lastProcessedAt: NOW - 20 * H, unprocessed: 4 });
    expect(a.ok).toBe(false);
    expect(a.checks.processing.ok).toBe(false);
    expect(a.checks.feed.ok).toBe(false);
  });
});
