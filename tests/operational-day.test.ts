import { describe, expect, it } from "vitest";

import {
  belongsToOperationalDay,
  calendarDateForOperationalTime,
  currentOperationalDay,
  DEFAULT_DAY_RESET_MINUTE,
  formatResetTime,
  groupedWithDayHint,
  isBeforeReset,
  isGroupedWithPreviousDay,
  isValidDayResetMinute,
  MAX_DAY_RESET_MINUTE,
  operationalDayDates,
  operationalDayOf,
  operationalDayOfRecord,
  operationalDayWindow,
  operationalSortMinute,
  operationalWallClock,
} from "@/lib/logic/operational-day";
import { DEFAULT_DAY_RESET_MINUTE as ENGINE_DEFAULT, resetMinuteOf } from "@/lib/logic/schedule";

/**
 * All tests use fixed instants and explicit timezones — never the host clock.
 * New York is UTC-5 (EST) / UTC-4 (EDT); Kolkata is UTC+5:30 year-round.
 */
const NY = "America/New_York";
const KOLKATA = "Asia/Kolkata";
const RESET = DEFAULT_DAY_RESET_MINUTE; // 4:00 AM

/** A wall-clock instant in standard-time New York (UTC-5). */
function nyWinter(wall: string): Date {
  return new Date(`${wall}-05:00`);
}

describe("constants and validation", () => {
  it("defaults to 4:00 AM and matches the engine's copy", () => {
    expect(DEFAULT_DAY_RESET_MINUTE).toBe(240);
    expect(ENGINE_DEFAULT).toBe(240);
  });

  it("accepts midnight through 6:00 AM, whole minutes only", () => {
    expect(isValidDayResetMinute(0)).toBe(true);
    expect(isValidDayResetMinute(240)).toBe(true);
    expect(isValidDayResetMinute(MAX_DAY_RESET_MINUTE)).toBe(true);
    expect(isValidDayResetMinute(361)).toBe(false);
    expect(isValidDayResetMinute(-1)).toBe(false);
    expect(isValidDayResetMinute(120.5)).toBe(false);
    expect(isValidDayResetMinute("240")).toBe(false);
    expect(isValidDayResetMinute(null)).toBe(false);
  });

  it("resetMinuteOf falls back to the default when settings predate the field", () => {
    expect(resetMinuteOf({})).toBe(240);
    expect(resetMinuteOf({ dayResetMinute: 0 })).toBe(0);
    expect(resetMinuteOf({ dayResetMinute: 300 })).toBe(300);
  });
});

describe("operationalDayOf — the boundary", () => {
  it("midnight belongs to the previous operational day", () => {
    expect(operationalDayOf(nyWinter("2026-01-15T00:00:00"), NY, RESET)).toBe("2026-01-14");
  });

  it("3:59 AM belongs to the previous operational day", () => {
    expect(operationalDayOf(nyWinter("2026-01-15T03:59:00"), NY, RESET)).toBe("2026-01-14");
  });

  it("4:00 AM begins the new operational day", () => {
    expect(operationalDayOf(nyWinter("2026-01-15T04:00:00"), NY, RESET)).toBe("2026-01-15");
  });

  it("an ordinary evening stays on its calendar date", () => {
    expect(operationalDayOf(nyWinter("2026-01-14T23:30:00"), NY, RESET)).toBe("2026-01-14");
  });

  it("a zero reset restores plain midnight days", () => {
    expect(operationalDayOf(nyWinter("2026-01-15T00:00:00"), NY, 0)).toBe("2026-01-15");
    expect(operationalDayOf(nyWinter("2026-01-15T03:59:00"), NY, 0)).toBe("2026-01-15");
  });

  it("resolves in the user's timezone, not the host's or UTC", () => {
    // 2026-01-15T07:30Z is 2:30 AM in New York (UTC-5): operational Jan 14
    // there, but already Jan 15 13:00 in Kolkata (UTC+5:30).
    const instant = new Date("2026-01-15T07:30:00Z");
    expect(operationalDayOf(instant, NY, RESET)).toBe("2026-01-14");
    expect(operationalDayOf(instant, KOLKATA, RESET)).toBe("2026-01-15");
  });

  it("handles a half-hour-offset zone at its own boundary", () => {
    // 3:59 AM in Kolkata is 22:29 UTC the previous day.
    expect(operationalDayOf(new Date("2026-01-14T22:29:00Z"), KOLKATA, RESET)).toBe("2026-01-14");
    expect(operationalDayOf(new Date("2026-01-14T22:30:00Z"), KOLKATA, RESET)).toBe("2026-01-15");
  });

  it("changing the reset setting regroups the same instant", () => {
    const halfPastOne = nyWinter("2026-01-15T01:30:00");
    expect(operationalDayOf(halfPastOne, NY, 240)).toBe("2026-01-14");
    expect(operationalDayOf(halfPastOne, NY, 60)).toBe("2026-01-15");
    expect(operationalDayOf(halfPastOne, NY, 0)).toBe("2026-01-15");
  });

  it("currentOperationalDay accepts an injected clock", () => {
    expect(currentOperationalDay(NY, RESET, nyWinter("2026-01-15T01:00:00"))).toBe("2026-01-14");
    expect(currentOperationalDay(NY, RESET, nyWinter("2026-01-15T09:00:00"))).toBe("2026-01-15");
  });
});

describe("daylight-saving transitions (America/New_York)", () => {
  it("spring forward: 2026-03-08 has no 2:30 AM, and the boundary still lands at 4:00", () => {
    // 03:59 EDT on the spring-forward day = 07:59 UTC (offset already -4).
    expect(operationalDayOf(new Date("2026-03-08T03:59:00-04:00"), NY, RESET)).toBe("2026-03-07");
    expect(operationalDayOf(new Date("2026-03-08T04:00:00-04:00"), NY, RESET)).toBe("2026-03-08");
    // 1:30 AM EST, before the jump, is still the previous operational day.
    expect(operationalDayOf(new Date("2026-03-08T01:30:00-05:00"), NY, RESET)).toBe("2026-03-07");
  });

  it("fall back: 2026-11-01 has two 1:30 AMs, both before the reset", () => {
    expect(operationalDayOf(new Date("2026-11-01T01:30:00-04:00"), NY, RESET)).toBe("2026-10-31");
    expect(operationalDayOf(new Date("2026-11-01T01:30:00-05:00"), NY, RESET)).toBe("2026-10-31");
    expect(operationalDayOf(new Date("2026-11-01T04:00:00-05:00"), NY, RESET)).toBe("2026-11-01");
  });

  it("the 2 AM jump lands inside the PREVIOUS operational day: 23 hours on spring forward, 25 on fall back", () => {
    const spring = operationalDayWindow("2026-03-07", NY, RESET);
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600 * 1000);
    const fall = operationalDayWindow("2026-10-31", NY, RESET);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600 * 1000);
    // The transition days themselves are ordinary 24-hour windows.
    const after = operationalDayWindow("2026-03-08", NY, RESET);
    expect(after.end.getTime() - after.start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("a reset inside the spring-forward gap still yields contiguous windows", () => {
    // 2:30 AM does not exist on 2026-03-08 in New York; the window resolver
    // lands on the instant the clocks jump to, and neighbouring windows meet.
    const before = operationalDayWindow("2026-03-07", NY, 150);
    const gapDay = operationalDayWindow("2026-03-08", NY, 150);
    expect(before.end.getTime()).toBe(gapDay.start.getTime());
  });
});

describe("operationalDayWindow", () => {
  it("spans reset to reset in real instants", () => {
    const { start, end } = operationalDayWindow("2026-01-14", NY, RESET);
    expect(start.toISOString()).toBe(new Date("2026-01-14T04:00:00-05:00").toISOString());
    expect(end.toISOString()).toBe(new Date("2026-01-15T04:00:00-05:00").toISOString());
  });

  it("is exactly the set of instants that resolve to the day", () => {
    const { start, end } = operationalDayWindow("2026-01-14", NY, RESET);
    expect(operationalDayOf(start, NY, RESET)).toBe("2026-01-14");
    expect(operationalDayOf(new Date(end.getTime() - 1000), NY, RESET)).toBe("2026-01-14");
    expect(operationalDayOf(end, NY, RESET)).toBe("2026-01-15");
  });
});

describe("isBeforeReset", () => {
  it("is true only between midnight and the reset", () => {
    expect(isBeforeReset(nyWinter("2026-01-15T01:00:00"), NY, RESET)).toBe(true);
    expect(isBeforeReset(nyWinter("2026-01-15T03:59:00"), NY, RESET)).toBe(true);
    expect(isBeforeReset(nyWinter("2026-01-15T04:00:00"), NY, RESET)).toBe(false);
    expect(isBeforeReset(nyWinter("2026-01-15T23:00:00"), NY, RESET)).toBe(false);
    expect(isBeforeReset(nyWinter("2026-01-15T01:00:00"), NY, 0)).toBe(false);
  });
});

describe("planner records — grouping without rewriting", () => {
  it("a 1:00 AM block belongs to the previous operational day", () => {
    const block = { date: "2026-01-15", startMinute: 60 };
    expect(operationalDayOfRecord(block, RESET)).toBe("2026-01-14");
    expect(isGroupedWithPreviousDay(block, RESET)).toBe(true);
    expect(belongsToOperationalDay(block, "2026-01-14", RESET)).toBe(true);
    expect(belongsToOperationalDay(block, "2026-01-15", RESET)).toBe(false);
    // The record itself is untouched — grouping never rewrites the date.
    expect(block.date).toBe("2026-01-15");
    expect(block.startMinute).toBe(60);
  });

  it("a 4:00 AM block starts the new day; untimed and all-day stay put", () => {
    expect(operationalDayOfRecord({ date: "2026-01-15", startMinute: 240 }, RESET)).toBe(
      "2026-01-15",
    );
    expect(operationalDayOfRecord({ date: "2026-01-15", startMinute: null }, RESET)).toBe(
      "2026-01-15",
    );
  });

  it("a zero reset never regroups", () => {
    expect(operationalDayOfRecord({ date: "2026-01-15", startMinute: 60 }, 0)).toBe("2026-01-15");
  });

  it("operationalDayDates spans the day and its after-midnight tail", () => {
    expect(operationalDayDates("2026-01-14", RESET)).toEqual(["2026-01-14", "2026-01-15"]);
    expect(operationalDayDates("2026-01-14", 0)).toEqual(["2026-01-14"]);
  });

  it("write path: entering 1:00 AM while planning a day lands on the next calendar date", () => {
    expect(calendarDateForOperationalTime("2026-01-14", 60, RESET)).toBe("2026-01-15");
    expect(calendarDateForOperationalTime("2026-01-14", 240, RESET)).toBe("2026-01-14");
    expect(calendarDateForOperationalTime("2026-01-14", null, RESET)).toBe("2026-01-14");
    // Round trip: the stored record resolves back to the day being planned.
    const stored = { date: calendarDateForOperationalTime("2026-01-14", 60, RESET), startMinute: 60 };
    expect(operationalDayOfRecord(stored, RESET)).toBe("2026-01-14");
  });
});

describe("operationalSortMinute — the extended axis", () => {
  it("pushes after-midnight times past the end of the evening", () => {
    expect(operationalSortMinute(23 * 60, RESET)).toBe(1380); // 11 PM stays
    expect(operationalSortMinute(60, RESET)).toBe(1500); // 1 AM sorts after it
    expect(operationalSortMinute(239, RESET)).toBe(1679); // 3:59 AM is the last minute
    expect(operationalSortMinute(240, RESET)).toBe(240); // 4 AM starts the day
    expect(operationalSortMinute(60, 0)).toBe(60); // zero reset: plain wall clock
  });
});

describe("operationalWallClock — reminders keep their real time", () => {
  it("a 9:00 AM reminder on operational Wednesday is Wednesday 9:00 AM", () => {
    expect(operationalWallClock("2026-01-14", 9 * 60, RESET)).toBe("2026-01-14T09:00:00");
  });

  it("a 1:00 AM reminder on operational Wednesday is Thursday 1:00 AM — not delayed to 4:00", () => {
    expect(operationalWallClock("2026-01-14", 60, RESET)).toBe("2026-01-15T01:00:00");
  });
});

describe("display helpers", () => {
  it("formats the reset and the grouping hint", () => {
    expect(formatResetTime(240)).toBe("4:00 AM");
    expect(formatResetTime(0)).toBe("12:00 AM");
    expect(groupedWithDayHint("Wednesday", 240)).toBe(
      "Grouped with Wednesday because your day resets at 4:00 AM.",
    );
  });
});
