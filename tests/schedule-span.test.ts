import { describe, expect, it } from "vitest";

import { wallClockToInstant } from "@/lib/logic/schedule";
import {
  comparePlannerSpans,
  crossesMidnight,
  endDateOf,
  resolvedEndMinute,
  spanDurationMinutes,
  type PlannerSpanLike,
} from "@/lib/logic/schedule-span";

// ---------------------------------------------------------------------------
// Cross-midnight resolution
// ---------------------------------------------------------------------------

describe("cross-midnight span resolution", () => {
  it("an end at or after the start stays on the same calendar date", () => {
    // 9:00 AM → 10:00 AM.
    expect(crossesMidnight(540, 600)).toBe(false);
    expect(endDateOf("2026-08-17", 540, 600)).toBe("2026-08-17");
    expect(spanDurationMinutes(540, 600)).toBe(60);
  });

  it("11:45 PM → 12:15 AM is a 30-minute block ending the next day", () => {
    expect(crossesMidnight(1425, 15)).toBe(true);
    expect(resolvedEndMinute(1425, 15)).toBe(1455);
    expect(spanDurationMinutes(1425, 15)).toBe(30);
    expect(endDateOf("2026-08-17", 1425, 15)).toBe("2026-08-18");
  });

  it("10:00 PM → 1:00 AM is 3 hours; 11:00 PM → 3:30 AM is 4.5 hours", () => {
    expect(spanDurationMinutes(1320, 60)).toBe(180);
    expect(endDateOf("2026-08-17", 1320, 60)).toBe("2026-08-18");
    expect(spanDurationMinutes(1380, 210)).toBe(270);
  });

  it("equal start and end stays a zero-duration point item, never 24 hours", () => {
    expect(crossesMidnight(540, 540)).toBe(false);
    expect(resolvedEndMinute(540, 540)).toBe(540);
    expect(spanDurationMinutes(540, 540)).toBe(0);
    expect(endDateOf("2026-08-17", 540, 540)).toBe("2026-08-17");
  });

  it("missing bounds resolve to nothing rather than guessing", () => {
    expect(crossesMidnight(null, 15)).toBe(false);
    expect(crossesMidnight(1425, null)).toBe(false);
    expect(spanDurationMinutes(null, 15)).toBeNull();
    expect(spanDurationMinutes(1425, null)).toBeNull();
    expect(endDateOf("2026-08-17", 1425, null)).toBe("2026-08-17");
  });

  it("a wrapped end crossing a month boundary lands on the right date", () => {
    expect(endDateOf("2026-08-31", 1425, 15)).toBe("2026-09-01");
    expect(endDateOf("2026-12-31", 1425, 15)).toBe("2027-01-01");
  });
});

describe("cross-midnight resolution against real timezone-aware instants", () => {
  // The stored form is (start date, wall-clock minutes); the real end instant
  // is the wall clock `endDateOf(...) T end` resolved in the user's timezone.
  const instant = (wall: string, tz: string) => wallClockToInstant(wall, tz)?.getTime();

  it("Aug 17 11:45 PM → Aug 18 12:15 AM is exactly 30 real minutes in New York", () => {
    const start = instant("2026-08-17T23:45", "America/New_York");
    const endDay = endDateOf("2026-08-17", 1425, 15);
    const end = instant(`${endDay}T00:15`, "America/New_York");
    expect(end! - start!).toBe(30 * 60 * 1000);
  });

  it("keeps local wall-clock times across the DST fall-back night", () => {
    // US fall-back 2026: clocks leave DST on Nov 1 at 2:00 AM. A block
    // 11:45 PM Oct 31 → 12:15 AM Nov 1 ends before the transition: still 30
    // real minutes, and both endpoints are the literal wall clocks.
    const start = instant("2026-10-31T23:45", "America/New_York");
    const end = instant(`${endDateOf("2026-10-31", 1425, 15)}T00:15`, "America/New_York");
    expect(end! - start!).toBe(30 * 60 * 1000);
  });

  it("a block whose small-hours tail crosses spring-forward keeps its wall clocks", () => {
    // US spring-forward 2026: Mar 8, 2:00 AM → 3:00 AM. 11:00 PM Mar 7 →
    // 3:30 AM Mar 8 is a 4.5-hour wall span containing the lost hour: the
    // wall clocks stand, so the real elapsed time is 4.5 − 1 = 3.5 hours.
    expect(spanDurationMinutes(1380, 210)).toBe(270);
    const start = instant("2026-03-07T23:00", "America/New_York");
    const end = instant(`${endDateOf("2026-03-07", 1380, 210)}T03:30`, "America/New_York");
    expect(end! - start!).toBe(3.5 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// The chronological comparator
// ---------------------------------------------------------------------------

function item(
  id: string,
  date: string,
  startMinute: number | null,
  endMinute: number | null,
  extra: Partial<PlannerSpanLike> = {},
): PlannerSpanLike & { id: string } {
  return { id, date, startMinute, endMinute, allDay: false, sortOrder: 0, ...extra };
}

const sortIds = (items: Array<PlannerSpanLike & { id: string }>, untimed?: "first" | "last") =>
  items
    .slice()
    .sort((a, b) => comparePlannerSpans(a, b, untimed))
    .map((entry) => entry.id);

describe("comparePlannerSpans", () => {
  it("earlier starts sort first", () => {
    const items = [item("b", "2026-08-17", 600, 660), item("a", "2026-08-17", 540, 600)];
    expect(sortIds(items)).toEqual(["a", "b"]);
  });

  it("pins the reported case: Wake Up 9:00 before Cardio 9:00–10:00, in any input order", () => {
    const cardio = item("cardio", "2026-08-17", 540, 600);
    const wakeUp = item("wakeUp", "2026-08-17", 540, 540);
    expect(sortIds([cardio, wakeUp])).toEqual(["wakeUp", "cardio"]);
    expect(sortIds([wakeUp, cardio])).toEqual(["wakeUp", "cardio"]);
  });

  it("same start: point, then shorter, then longer — Wake Up, Mobility, Cardio, Work", () => {
    const items = [
      item("work", "2026-08-17", 540, 720),
      item("cardio", "2026-08-17", 540, 600),
      item("wakeUp", "2026-08-17", 540, 540),
      item("mobility", "2026-08-17", 540, 570),
    ];
    expect(sortIds(items)).toEqual(["wakeUp", "mobility", "cardio", "work"]);
  });

  it("a missing end counts as a point — before any same-start interval", () => {
    const items = [item("block", "2026-08-17", 540, 600), item("open", "2026-08-17", 540, null)];
    expect(sortIds(items)).toEqual(["open", "block"]);
  });

  it("a same-start cross-midnight end sorts after every same-day end", () => {
    // 11:45 PM point, → 11:55 PM, → 12:15 AM next day: resolved ends
    // 1425 < 1435 < 1455.
    const items = [
      item("wrapped", "2026-08-17", 1425, 15),
      item("short", "2026-08-17", 1425, 1435),
      item("point", "2026-08-17", 1425, 1425),
    ];
    expect(sortIds(items)).toEqual(["point", "short", "wrapped"]);
  });

  it("orders across calendar midnight by real chronology", () => {
    const items = [
      item("tueEarly", "2026-08-18", 15, 60),
      item("monLate", "2026-08-17", 1425, 15),
      item("tueLater", "2026-08-18", 60, 120),
    ];
    expect(sortIds(items)).toEqual(["monLate", "tueEarly", "tueLater"]);
  });

  it("orders a 4:00 AM operational day: Mon 11:45 PM, then Tue 12:15 AM, then Tue 1:00 AM", () => {
    // All three group under operational Monday (reset 4:00 AM); the tail rows
    // are STORED on Tuesday, so date-then-minute is already the extended axis.
    const items = [
      item("one-am", "2026-08-18", 60, 90),
      item("quarter-past", "2026-08-18", 15, 45),
      item("late-mon", "2026-08-17", 1425, 1440 - 1),
    ];
    expect(sortIds(items)).toEqual(["late-mon", "quarter-past", "one-am"]);
  });

  it("identical spans fall back to sortOrder, then id — never input order", () => {
    const byOrder = [
      item("second", "2026-08-17", 540, 600, { sortOrder: 2 }),
      item("first", "2026-08-17", 540, 600, { sortOrder: 1 }),
    ];
    expect(sortIds(byOrder)).toEqual(["first", "second"]);

    const byId = [
      item("zz", "2026-08-17", 540, 600),
      item("aa", "2026-08-17", 540, 600),
    ];
    expect(sortIds(byId)).toEqual(["aa", "zz"]);
    expect(sortIds(byId.slice().reverse())).toEqual(["aa", "zz"]);
  });

  it("sortOrder never overrides chronology", () => {
    const items = [
      item("late-but-first", "2026-08-17", 600, 660, { sortOrder: 0 }),
      item("early-but-last", "2026-08-17", 540, 600, { sortOrder: 99 }),
    ];
    expect(sortIds(items)).toEqual(["early-but-last", "late-but-first"]);
  });

  it("untimed items pin to the top by default and to the bottom on request", () => {
    const items = [
      item("timed", "2026-08-17", 540, 600),
      item("allday", "2026-08-17", null, null, { allDay: true }),
    ];
    expect(sortIds(items)).toEqual(["allday", "timed"]);
    expect(sortIds(items, "last")).toEqual(["timed", "allday"]);
  });

  it("recurring occurrences on different days keep chronological order", () => {
    // Same series, same wall clocks, consecutive dates — like a materialised
    // Mon/Tue/Thu 11:45 PM series. Order must follow the dates.
    const items = [
      item("thu", "2026-08-20", 1425, 15),
      item("mon", "2026-08-17", 1425, 15),
      item("tue", "2026-08-18", 1425, 15),
    ];
    expect(sortIds(items)).toEqual(["mon", "tue", "thu"]);
  });
});
