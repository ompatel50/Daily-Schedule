import { describe, expect, it } from "vitest";

import {
  heatLevel,
  linearTrend,
  movingAverage,
  trendDelta,
} from "@/lib/logic/scoring";

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
