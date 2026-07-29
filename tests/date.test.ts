import { describe, expect, it } from "vitest";

import {
  dayRange,
  daysBetween,
  formatDuration,
  formatMinute,
  formatTimeRange,
  fromDayKey,
  isDayKey,
  isFuture,
  isPast,
  isToday,
  lastNDays,
  relativeDayLabel,
  minuteToTimeValue,
  monthGridDays,
  parseTimeToMinute,
  shiftDay,
  toDayKey,
  weekDays,
  weekRange,
  weekdayOf,
} from "@/lib/date";
import { totalVolume, estimateOneRepMax, pacePerKm, formatPace } from "@/lib/logic/workouts";

describe("day keys", () => {
  it("round-trips through Date without timezone drift", () => {
    expect(toDayKey(fromDayKey("2026-03-02"))).toBe("2026-03-02");
    // A DST boundary in the US (2026-03-08) must not shift the day.
    expect(toDayKey(fromDayKey("2026-03-08"))).toBe("2026-03-08");
  });

  it("validates the format", () => {
    expect(isDayKey("2026-03-02")).toBe(true);
    expect(isDayKey("2026-3-2")).toBe(false);
    expect(isDayKey("not a date")).toBe(false);
    expect(isDayKey("2026-13-40")).toBe(false);
    expect(isDayKey(42)).toBe(false);
  });

  it("throws on an invalid key rather than returning a bad Date", () => {
    expect(() => fromDayKey("nope")).toThrow();
  });

  it("shifts across month and year boundaries", () => {
    expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("measures calendar distance", () => {
    expect(daysBetween("2026-03-01", "2026-03-05")).toBe(4);
    expect(daysBetween("2026-03-05", "2026-03-01")).toBe(-4);
  });
});

describe("ranges", () => {
  it("builds an inclusive range", () => {
    expect(dayRange("2026-03-01", "2026-03-03")).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
  });

  it("returns nothing for an inverted range", () => {
    expect(dayRange("2026-03-05", "2026-03-01")).toEqual([]);
  });

  it("ends `lastNDays` on the given day", () => {
    const days = lastNDays(3, "2026-03-05");
    expect(days).toEqual(["2026-03-03", "2026-03-04", "2026-03-05"]);
  });

  it("builds Monday-start weeks", () => {
    // 2026-03-04 is a Wednesday.
    expect(weekRange("2026-03-04", 1)).toEqual({ start: "2026-03-02", end: "2026-03-08" });
    expect(weekDays("2026-03-04", 1)).toHaveLength(7);
  });

  it("builds Sunday-start weeks", () => {
    expect(weekRange("2026-03-04", 0)).toEqual({ start: "2026-03-01", end: "2026-03-07" });
  });

  it("pads a month grid to whole weeks", () => {
    const grid = monthGridDays("2026-03-15", 1);
    expect(grid.length % 7).toBe(0);
    expect(grid).toContain("2026-03-01");
    expect(grid).toContain("2026-03-31");
  });

  it("reports the weekday", () => {
    expect(weekdayOf("2026-03-02")).toBe(1); // Monday
    expect(weekdayOf("2026-03-08")).toBe(0); // Sunday
  });
});

/**
 * The server resolves "today" from the user's configured timezone; the host
 * clock can be a day off. Every helper that decides past / today / future has
 * to be able to take that day as an argument, or the Today page ends up titled
 * "Yesterday" and a hand-off link lands on a different day than the one you
 * left.
 */
describe("relative days against a supplied reference", () => {
  it("labels the reference day itself as Today", () => {
    expect(relativeDayLabel("2026-07-28", "2026-07-28")).toBe("Today");
    expect(relativeDayLabel("2026-07-29", "2026-07-28")).toBe("Tomorrow");
    expect(relativeDayLabel("2026-07-27", "2026-07-28")).toBe("Yesterday");
  });

  it("does not call the reference day yesterday when the host clock has moved on", () => {
    // The exact regression: host is 2026-07-29 (UTC), the user is in
    // America/New_York where it is still 2026-07-28.
    expect(relativeDayLabel("2026-07-28", "2026-07-29")).toBe("Yesterday");
    expect(relativeDayLabel("2026-07-28", "2026-07-28")).toBe("Today");
  });

  it("names nearby days and dates further out", () => {
    expect(relativeDayLabel("2026-07-31", "2026-07-28")).toBe("Friday");
    expect(relativeDayLabel("2026-08-20", "2026-07-28")).toBe("Aug 20");
  });

  it("answers is-today, is-past and is-future against the reference", () => {
    expect(isToday("2026-07-28", "2026-07-28")).toBe(true);
    expect(isToday("2026-07-29", "2026-07-28")).toBe(false);

    expect(isPast("2026-07-27", "2026-07-28")).toBe(true);
    expect(isPast("2026-07-28", "2026-07-28")).toBe(false);
    expect(isPast("2026-07-29", "2026-07-28")).toBe(false);

    expect(isFuture("2026-07-29", "2026-07-28")).toBe(true);
    expect(isFuture("2026-07-28", "2026-07-28")).toBe(false);
    expect(isFuture("2026-07-27", "2026-07-28")).toBe(false);
  });

  it("treats the reference day as neither past nor future — a day is not overdue on itself", () => {
    expect(isPast("2026-07-28", "2026-07-28")).toBe(false);
    expect(isFuture("2026-07-28", "2026-07-28")).toBe(false);
  });

  it("crosses month and year boundaries", () => {
    expect(relativeDayLabel("2026-08-01", "2026-07-31")).toBe("Tomorrow");
    expect(relativeDayLabel("2025-12-31", "2026-01-01")).toBe("Yesterday");
    expect(isPast("2025-12-31", "2026-01-01")).toBe(true);
  });
});

describe("time formatting", () => {
  it("formats minutes as 12-hour clock time", () => {
    expect(formatMinute(0)).toBe("12:00 AM");
    expect(formatMinute(9 * 60 + 5)).toBe("9:05 AM");
    expect(formatMinute(12 * 60)).toBe("12:00 PM");
    expect(formatMinute(18 * 60 + 30)).toBe("6:30 PM");
  });

  it("parses time inputs", () => {
    expect(parseTimeToMinute("07:30")).toBe(450);
    expect(parseTimeToMinute("23:59")).toBe(1439);
    expect(parseTimeToMinute("24:00")).toBeNull();
    expect(parseTimeToMinute("garbage")).toBeNull();
  });

  it("round-trips to an input value", () => {
    expect(minuteToTimeValue(450)).toBe("07:30");
    expect(parseTimeToMinute(minuteToTimeValue(1234))).toBe(1234);
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(95)).toBe("1h 35m");
  });

  it("formats time ranges", () => {
    expect(formatTimeRange(null, null, true)).toBe("All day");
    expect(formatTimeRange(540, null, false)).toBe("9:00 AM");
    expect(formatTimeRange(540, 660, false)).toBe("9:00 AM – 11:00 AM");
  });
});

describe("workout maths", () => {
  it("sums volume across completed sets", () => {
    expect(
      totalVolume([
        { exercise: "Squat", reps: 5, weightKg: 100 },
        { exercise: "Squat", reps: 5, weightKg: 100 },
      ]),
    ).toBe(1000);
  });

  it("ignores incomplete sets", () => {
    expect(
      totalVolume([
        { exercise: "Squat", reps: 5, weightKg: 100 },
        { exercise: "Squat", reps: 5, weightKg: 100, completed: false },
      ]),
    ).toBe(500);
  });

  it("estimates a one-rep max", () => {
    expect(estimateOneRepMax(100, 1)).toBe(100);
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(116.7, 1);
    expect(estimateOneRepMax(0, 5)).toBe(0);
  });

  it("computes and formats pace", () => {
    expect(pacePerKm(10, 50)).toBe(5);
    expect(formatPace(5.5)).toBe("5:30 /km");
    expect(formatPace(null)).toBe("—");
    expect(pacePerKm(0, 50)).toBeNull();
  });
});
