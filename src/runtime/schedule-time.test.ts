import { describe, expect, it } from "vitest";
import { MIN_INTERVAL_MINUTES, ScheduleSpecSchema, isValidTimeZone, localParts, nextOccurrence, zonedTimeToUtc } from "./schedule-time.js";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("the schedule shapes", () => {
  it("accepts the three shapes and refuses everything else, including runs more often than every 15 minutes", () => {
    expect(ScheduleSpecSchema.safeParse({ type: "daily", time: "08:30" }).success).toBe(true);
    expect(ScheduleSpecSchema.safeParse({ type: "weekly", days: [1, 3, 5], time: "23:59" }).success).toBe(true);
    expect(ScheduleSpecSchema.safeParse({ type: "interval", everyMinutes: MIN_INTERVAL_MINUTES }).success).toBe(true);
    for (const bad of [
      { type: "interval", everyMinutes: MIN_INTERVAL_MINUTES - 1 },
      { type: "interval", everyMinutes: 1.5 },
      { type: "interval", everyMinutes: 99999 },
      { type: "daily", time: "24:00" },
      { type: "daily", time: "8:30" },
      { type: "weekly", days: [], time: "08:30" },
      { type: "weekly", days: [7], time: "08:30" },
      { type: "cron", expr: "* * * * *" },
      { type: "daily", time: "08:30", extra: 1 },
    ]) {
      expect(ScheduleSpecSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("knows real time zones", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("converting a wall-clock time to an instant", () => {
  it("handles a zone with no daylight saving", () => {
    expect(iso(zonedTimeToUtc(2026, 10, 10, 8, 30, "Asia/Seoul"))).toBe("2026-10-09T23:30:00.000Z"); // UTC+9
    expect(iso(zonedTimeToUtc(2026, 10, 10, 8, 30, "UTC"))).toBe("2026-10-10T08:30:00.000Z");
  });

  it("follows daylight saving: the same wall-clock time is a different instant in summer and winter", () => {
    expect(iso(zonedTimeToUtc(2026, 7, 1, 8, 30, "America/New_York"))).toBe("2026-07-01T12:30:00.000Z"); // EDT, UTC-4
    expect(iso(zonedTimeToUtc(2026, 1, 15, 8, 30, "America/New_York"))).toBe("2026-01-15T13:30:00.000Z"); // EST, UTC-5
    const p = localParts(zonedTimeToUtc(2026, 3, 9, 8, 30, "America/New_York"), "America/New_York");
    expect([p.hour, p.minute]).toEqual([8, 30]);
  });

  it("puts a time that does not exist (spring forward) just after the gap, and a repeated one at its first occurrence", () => {
    // 2026-03-08 02:30 does not exist in New York: clocks jump from 02:00 to 03:00.
    const gap = zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York");
    const p = localParts(gap, "America/New_York");
    expect(p.day).toBe(8);
    expect(p.hour).toBeGreaterThanOrEqual(3);
    // 2026-11-01 01:30 happens twice; either instant reads 01:30 on the wall clock.
    const twice = localParts(zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York"), "America/New_York");
    expect([twice.hour, twice.minute]).toEqual([1, 30]);
  });
});

describe("the next run", () => {
  it("daily: today if the time has not passed, otherwise tomorrow, never the same instant", () => {
    const spec = ScheduleSpecSchema.parse({ type: "daily", time: "08:30" });
    expect(iso(nextOccurrence(spec, at("2026-10-09T20:00:00Z"), "Asia/Seoul"))).toBe("2026-10-09T23:30:00.000Z"); // 05:00 KST -> 08:30 KST today
    expect(iso(nextOccurrence(spec, at("2026-10-09T23:30:00Z"), "Asia/Seoul"))).toBe("2026-10-10T23:30:00.000Z"); // exactly on time -> tomorrow
    expect(iso(nextOccurrence(spec, at("2026-10-10T01:00:00Z"), "Asia/Seoul"))).toBe("2026-10-10T23:30:00.000Z");
  });

  it("weekly: the next chosen weekday, in the schedule's own zone (a Monday in Seoul is still Sunday in UTC)", () => {
    const spec = ScheduleSpecSchema.parse({ type: "weekly", days: [1], time: "09:00" }); // Mondays 09:00
    const next = nextOccurrence(spec, at("2026-10-10T12:00:00Z"), "Asia/Seoul"); // Saturday evening in Seoul
    expect(iso(next)).toBe("2026-10-12T00:00:00.000Z"); // Monday 2026-10-12 09:00 KST = 00:00 UTC
    expect(localParts(next, "Asia/Seoul").weekday).toBe(1);
    // After that Monday it is the following Monday.
    expect(iso(nextOccurrence(spec, next, "Asia/Seoul"))).toBe("2026-10-19T00:00:00.000Z");
  });

  it("weekly with several days picks the nearest, and crosses a month end", () => {
    const spec = ScheduleSpecSchema.parse({ type: "weekly", days: [1, 3, 5], time: "07:00" });
    expect(localParts(nextOccurrence(spec, at("2026-10-07T00:00:00Z"), "UTC"), "UTC")).toMatchObject({ day: 7, weekday: 3 }); // Wed 07:00 is still ahead
    const crossing = nextOccurrence(ScheduleSpecSchema.parse({ type: "daily", time: "06:00" }), at("2026-10-31T10:00:00Z"), "UTC");
    expect(iso(crossing)).toBe("2026-11-01T06:00:00.000Z");
    const year = nextOccurrence(ScheduleSpecSchema.parse({ type: "daily", time: "06:00" }), at("2026-12-31T10:00:00Z"), "UTC");
    expect(iso(year)).toBe("2027-01-01T06:00:00.000Z");
  });

  it("keeps wall-clock time across a daylight-saving change", () => {
    const spec = ScheduleSpecSchema.parse({ type: "daily", time: "08:30" });
    const beforeChange = nextOccurrence(spec, at("2026-03-07T20:00:00Z"), "America/New_York"); // Sat evening, before spring forward
    expect(iso(beforeChange)).toBe("2026-03-08T12:30:00.000Z"); // Sun 08:30 EDT (the clocks changed at 02:00 that night)
    const dayAfter = nextOccurrence(spec, beforeChange, "America/New_York");
    expect(localParts(dayAfter, "America/New_York")).toMatchObject({ day: 9, hour: 8, minute: 30 });
    expect(dayAfter.getTime() - beforeChange.getTime()).toBe(24 * 3_600_000); // an ordinary day after the change
  });

  it("interval: stays on its rhythm however late a run was, and always moves forward", () => {
    const spec = ScheduleSpecSchema.parse({ type: "interval", everyMinutes: 60 });
    const anchor = at("2026-10-10T00:00:00Z");
    expect(iso(nextOccurrence(spec, at("2026-10-10T00:00:00Z"), "UTC", anchor))).toBe("2026-10-10T01:00:00.000Z");
    expect(iso(nextOccurrence(spec, at("2026-10-10T00:40:00Z"), "UTC", anchor))).toBe("2026-10-10T01:00:00.000Z");
    expect(iso(nextOccurrence(spec, at("2026-10-10T05:10:00Z"), "UTC", anchor))).toBe("2026-10-10T06:00:00.000Z"); // skips the slots missed while down
    expect(nextOccurrence(spec, at("2026-10-09T00:00:00Z"), "UTC", anchor).getTime()).toBeGreaterThan(at("2026-10-09T00:00:00Z").getTime());
  });
});
