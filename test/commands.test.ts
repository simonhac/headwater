import { describe, it, expect } from "vitest";
import { parseLocalTime, formatLocalTime, nextSendLabel } from "@/lib/slack/commands";

describe("parseLocalTime", () => {
  it.each([
    ["7", 420],
    ["07", 420],
    ["7:30", 450],
    ["7.30", 450],
    ["7am", 420],
    ["7 am", 420],
    ["7:30pm", 19 * 60 + 30],
    ["19:15", 19 * 60 + 15],
    ["12am", 0],
    ["12pm", 12 * 60],
    ["12:30am", 30],
    ["0:00", 0],
    ["23:45", 23 * 60 + 45],
  ])("parses %s → %d", (raw, minute) => {
    expect(parseLocalTime(raw)).toEqual({ minute, rounded: false });
  });

  it("rounds to the nearest quarter hour and says so", () => {
    expect(parseLocalTime("7:25")).toEqual({ minute: 450, rounded: true }); // → 7:30
    expect(parseLocalTime("7:20")).toEqual({ minute: 435, rounded: true }); // → 7:15
    expect(parseLocalTime("7:07")).toEqual({ minute: 420, rounded: true }); // → 7:00
    expect(parseLocalTime("23:55")).toEqual({ minute: 0, rounded: true }); // wraps to midnight
  });

  it.each(["", "abc", "25", "13pm", "0am", "7:60", "7:5", "7:30:00", "noon"])("rejects %j", (raw) => {
    expect(parseLocalTime(raw)).toBeNull();
  });
});

describe("formatLocalTime", () => {
  it("prints 12-hour times", () => {
    expect(formatLocalTime(0)).toBe("12:00am");
    expect(formatLocalTime(450)).toBe("7:30am");
    expect(formatLocalTime(12 * 60)).toBe("12:00pm");
    expect(formatLocalTime(13 * 60 + 15)).toBe("1:15pm");
  });
});

describe("nextSendLabel", () => {
  const TZ = "Australia/Melbourne";
  const JAN_15_0600 = Date.UTC(2026, 0, 14, 19, 0); // 06:00 AEDT on 15 Jan
  const JAN_15_1000 = Date.UTC(2026, 0, 14, 23, 0); // 10:00 AEDT on 15 Jan

  it("says today when the time is still ahead", () => {
    expect(nextSendLabel({ time_zone: TZ, send_minute: 480, last_sent_day: null }, JAN_15_0600)).toBe("today at 8:00am");
  });

  it("says tomorrow once today's has gone out", () => {
    expect(nextSendLabel({ time_zone: TZ, send_minute: 480, last_sent_day: "2026-01-15" }, JAN_15_1000)).toBe(
      "tomorrow at 8:00am",
    );
  });

  it("flags a pending catch-up when the time has passed but nothing was sent", () => {
    expect(nextSendLabel({ time_zone: TZ, send_minute: 480, last_sent_day: null }, JAN_15_1000)).toMatch(/within the next/);
  });
});
