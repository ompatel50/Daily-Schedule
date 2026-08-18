import { describe, expect, it } from "vitest";

import { weekUtilization, type UtilizationBlock } from "@/lib/logic/utilization";

function block(overrides: Partial<UtilizationBlock> = {}): UtilizationBlock {
  return {
    category: "work",
    startMinute: 9 * 60,
    endMinute: 10 * 60,
    allDay: false,
    status: "planned",
    ...overrides,
  };
}

const WINDOW = { dayStartHour: 7, dayEndHour: 22 }; // 15 waking hours

describe("weekUtilization", () => {
  it("sums planned and done minutes per category, most-planned first", () => {
    const summary = weekUtilization(
      [
        block({ category: "work", startMinute: 9 * 60, endMinute: 12 * 60, status: "done" }),
        block({ category: "work", startMinute: 13 * 60, endMinute: 14 * 60 }),
        block({ category: "fitness", startMinute: 7 * 60, endMinute: 8 * 60, status: "done" }),
      ],
      WINDOW,
    );
    expect(summary.rows).toEqual([
      { category: "work", plannedMinutes: 240, doneMinutes: 180, blocks: 2 },
      { category: "fitness", plannedMinutes: 60, doneMinutes: 60, blocks: 1 },
    ]);
    expect(summary.totalPlannedMinutes).toBe(300);
    expect(summary.totalDoneMinutes).toBe(240);
    expect(summary.completionRatio).toBeCloseTo(0.8);
  });

  it("free time is the waking week minus planned time, never negative", () => {
    const summary = weekUtilization([block()], WINDOW);
    expect(summary.availableMinutes).toBe(15 * 60 * 7);
    expect(summary.freeMinutes).toBe(15 * 60 * 7 - 60);

    const overbooked = weekUtilization(
      Array.from({ length: 200 }, () => block({ startMinute: 0, endMinute: 23 * 60 })),
      WINDOW,
    );
    expect(overbooked.freeMinutes).toBe(0);
  });

  it("skipped blocks count nowhere; untimed blocks are counted, not summed", () => {
    const summary = weekUtilization(
      [
        block({ status: "skipped" }),
        block({ allDay: true, startMinute: null, endMinute: null }),
        block({ startMinute: 9 * 60, endMinute: 9 * 60 }), // zero-length
      ],
      WINDOW,
    );
    expect(summary.totalPlannedMinutes).toBe(0);
    expect(summary.untimedCount).toBe(2);
    expect(summary.rows).toEqual([]);
    expect(summary.completionRatio).toBeNull();
  });

  it("a cross-midnight block carries its real duration", () => {
    const summary = weekUtilization(
      [block({ startMinute: 23 * 60, endMinute: 60 })], // 11 PM → 1 AM
      WINDOW,
    );
    expect(summary.totalPlannedMinutes).toBe(120);
  });
});
