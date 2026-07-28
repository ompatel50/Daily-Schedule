import { describe, expect, it } from "vitest";

import {
  calorieAccuracy,
  heatLevel,
  linearTrend,
  movingAverage,
  scoreDay,
  trendDelta,
} from "@/lib/logic/scoring";

const baseDay = {
  plannedCount: 0,
  completedCount: 0,
  habitsDue: 0,
  habitsDone: 0,
  calories: 0,
  calorieGoal: 0,
  workoutMinutes: 0,
  workoutMinuteGoal: 0,
  loggedNutrition: false,
};

describe("scoreDay", () => {
  it("returns zero when there is nothing to score", () => {
    expect(scoreDay(baseDay)).toBe(0);
  });

  it("scores a perfect day at 100", () => {
    expect(
      scoreDay({
        ...baseDay,
        plannedCount: 5,
        completedCount: 5,
        habitsDue: 4,
        habitsDone: 4,
        calories: 2400,
        calorieGoal: 2400,
        loggedNutrition: true,
        workoutMinutes: 60,
        workoutMinuteGoal: 45,
      }),
    ).toBe(100);
  });

  it("only weights the dimensions that have data", () => {
    // Planner only, half done → 50.
    expect(scoreDay({ ...baseDay, plannedCount: 4, completedCount: 2 })).toBe(50);
  });

  it("blends planner and habits evenly when both are present", () => {
    // Planner 100%, habits 0% → equal weights → 50.
    expect(
      scoreDay({ ...baseDay, plannedCount: 2, completedCount: 2, habitsDue: 2, habitsDone: 0 }),
    ).toBe(50);
  });

  it("ignores nutrition when nothing was logged", () => {
    const withoutFood = scoreDay({ ...baseDay, plannedCount: 2, completedCount: 1, calorieGoal: 2000 });
    expect(withoutFood).toBe(50);
  });

  it("caps over-achievement at 100%", () => {
    expect(
      scoreDay({ ...baseDay, workoutMinutes: 500, workoutMinuteGoal: 45 }),
    ).toBe(100);
  });
});

describe("calorieAccuracy", () => {
  it("gives full credit within 10% of the goal", () => {
    expect(calorieAccuracy(2400, 2400)).toBe(1);
    expect(calorieAccuracy(2200, 2400)).toBe(1);
  });

  it("penalises over- and under-eating equally", () => {
    expect(calorieAccuracy(1800, 2400)).toBeCloseTo(calorieAccuracy(3000, 2400), 5);
  });

  it("bottoms out beyond ±50%", () => {
    expect(calorieAccuracy(1000, 2400)).toBe(0);
    expect(calorieAccuracy(4000, 2400)).toBe(0);
  });

  it("returns zero without a goal or intake", () => {
    expect(calorieAccuracy(2000, 0)).toBe(0);
    expect(calorieAccuracy(0, 2000)).toBe(0);
  });
});

describe("heatLevel", () => {
  it("maps scores to buckets", () => {
    expect(heatLevel(0, false)).toBe(0);
    expect(heatLevel(90, false)).toBe(0); // no data wins
    expect(heatLevel(20, true)).toBe(1);
    expect(heatLevel(50, true)).toBe(2);
    expect(heatLevel(70, true)).toBe(3);
    expect(heatLevel(95, true)).toBe(4);
  });
});

describe("trendDelta", () => {
  it("computes a percentage change", () => {
    expect(trendDelta(120, 100)).toBe(20);
    expect(trendDelta(80, 100)).toBe(-20);
    expect(trendDelta(100, 100)).toBe(0);
  });

  it("handles a zero baseline", () => {
    expect(trendDelta(0, 0)).toBe(0);
    expect(trendDelta(50, 0)).toBe(100);
  });
});

describe("movingAverage", () => {
  it("smooths a series over the window", () => {
    expect(movingAverage([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });

  it("skips nulls without breaking the window", () => {
    expect(movingAverage([2, null, 4], 3)).toEqual([2, 2, 3]);
  });

  it("returns null where there is no data at all", () => {
    expect(movingAverage([null, null], 2)).toEqual([null, null]);
  });
});

describe("linearTrend", () => {
  it("detects a rising series", () => {
    expect(
      linearTrend([
        { x: 0, y: 10 },
        { x: 1, y: 20 },
        { x: 2, y: 30 },
      ]),
    ).toBeCloseTo(10);
  });

  it("returns zero for a flat or single-point series", () => {
    expect(linearTrend([{ x: 0, y: 5 }])).toBe(0);
    expect(
      linearTrend([
        { x: 0, y: 5 },
        { x: 1, y: 5 },
      ]),
    ).toBe(0);
  });
});
