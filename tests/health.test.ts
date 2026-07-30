import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  aggregateDay,
  aggregateDayAll,
  aggregateSeries,
  ASLEEP_STAGES,
  HEALTH_METRIC_RULES,
  HEALTH_SOURCE_META,
  intervalHours,
  isSupportedUnit,
  mergeIntervals,
  sourceLabel,
  toCanonical,
  toDisplay,
  type HealthRowLike,
} from "@/lib/logic/health";
import { healthMetricSchema } from "@/lib/validation";
import { HEALTH_METRIC_TYPES } from "@/lib/enums";

const row = (partial: Partial<HealthRowLike> & { type: string; value: number }): HealthRowLike => ({
  unit: HEALTH_METRIC_RULES[partial.type]?.canonicalUnit ?? "",
  source: "manual",
  date: "2026-03-14",
  ...partial,
});

describe("metric registry", () => {
  it("covers every metric type the app declares", () => {
    for (const type of HEALTH_METRIC_TYPES) {
      expect(HEALTH_METRIC_RULES[type], `missing rule for ${type}`).toBeTruthy();
    }
  });

  it("documents an aggregation kind and canonical unit for every rule", () => {
    for (const [type, rule] of Object.entries(HEALTH_METRIC_RULES)) {
      expect(["cumulative", "latest", "average", "sample_range", "sleep"]).toContain(rule.kind);
      expect(typeof rule.canonicalUnit, type).toBe("string");
    }
  });
});

describe("unit normalization", () => {
  it("converts mass to kilograms", () => {
    expect(toCanonical("body_weight", 180, "lb")).toBeCloseTo(81.6466, 3);
    expect(toCanonical("body_weight", 81.5, "kg")).toBe(81.5);
    expect(toCanonical("body_weight", 81500, "g")).toBeCloseTo(81.5, 6);
  });

  it("converts volume to millilitres", () => {
    expect(toCanonical("hydration_ml", 2.5, "l")).toBe(2500);
    expect(toCanonical("hydration_ml", 500, "ml")).toBe(500);
    expect(toCanonical("hydration_ml", 8, "fl_oz_us")).toBeCloseTo(236.588, 2);
  });

  it("converts energy to kilocalories, including kilojoules", () => {
    expect(toCanonical("active_calories", 180.5, "Cal")).toBe(180.5);
    expect(toCanonical("resting_calories", 1673.6, "kJ")).toBeCloseTo(400, 0);
  });

  it("converts duration to hours", () => {
    expect(toCanonical("sleep_hours", 450, "min")).toBe(7.5);
    expect(toCanonical("sleep_hours", 7.5, "h")).toBe(7.5);
  });

  it("converts distance to kilometres", () => {
    expect(toCanonical("distance_km", 3, "mi")).toBeCloseTo(4.828, 2);
    expect(toCanonical("distance_km", 800, "m")).toBeCloseTo(0.8, 6);
  });

  it("returns null for a unit the metric cannot express, rather than guessing", () => {
    expect(toCanonical("body_weight", 10, "furlongs")).toBeNull();
    expect(toCanonical("hydration_ml", 10, "kg")).toBeNull();
    expect(isSupportedUnit("steps", "kg")).toBe(false);
    expect(isSupportedUnit("steps", "count")).toBe(true);
  });

  it("converts canonical values into the user's display units", () => {
    expect(toDisplay("body_weight", 81.6466266, "imperial").value).toBeCloseTo(180, 3);
    expect(toDisplay("body_weight", 81.6466266, "imperial").unit).toBe("lb");
    expect(toDisplay("body_weight", 80, "metric")).toEqual({ value: 80, unit: "kg" });
    expect(toDisplay("distance_km", 1.609344, "imperial").value).toBeCloseTo(1, 6);
    expect(toDisplay("steps", 100, "imperial")).toEqual({ value: 100, unit: "" });
  });
});

describe("cumulative metrics (steps, calories, hydration, distance)", () => {
  it("sums records within one source", () => {
    const value = aggregateDay("steps", [
      row({ type: "steps", value: 4000 }),
      row({ type: "steps", value: 2500 }),
    ]);
    expect(value?.value).toBe(6500);
  });

  it("takes the fullest device across sources instead of adding devices together", () => {
    const value = aggregateDay("steps", [
      row({ type: "steps", value: 6000, source: "apple_health", sourceApp: "Watch" }),
      row({ type: "steps", value: 2000, source: "apple_health", sourceApp: "Watch" }),
      row({ type: "steps", value: 7500, source: "apple_health", sourceApp: "Phone" }),
    ]);
    // Watch total 8000 beats phone 7500; they are never summed to 15500.
    expect(value?.value).toBe(8000);
    expect(value?.sources).toEqual(["apple_health"]);
  });

  it("keeps a manual daily total separate from an import", () => {
    const value = aggregateDay("hydration_ml", [
      row({ type: "hydration_ml", value: 2000, source: "manual" }),
      row({ type: "hydration_ml", value: 500, source: "apple_health", sourceApp: "WaterApp" }),
      row({ type: "hydration_ml", value: 750, source: "apple_health", sourceApp: "WaterApp" }),
    ]);
    expect(value?.value).toBe(2000); // manual 2000 vs import 1250 — best wins
    expect(value?.sources.sort()).toEqual(["apple_health", "manual"]);
  });

  it("converts units before summing", () => {
    const value = aggregateDay("hydration_ml", [
      row({ type: "hydration_ml", value: 1.5, unit: "l" }),
      row({ type: "hydration_ml", value: 500, unit: "ml" }),
    ]);
    expect(value?.value).toBe(2000);
  });
});

describe("latest metrics (weight, body fat, blood pressure)", () => {
  it("picks the day's latest reading by timestamp", () => {
    const value = aggregateDay("body_weight", [
      row({ type: "body_weight", value: 81.0, recordedAt: new Date("2026-03-14T07:00:00Z") }),
      row({ type: "body_weight", value: 80.4, recordedAt: new Date("2026-03-14T21:00:00Z") }),
    ]);
    expect(value?.value).toBe(80.4);
  });

  it("converts legacy pound rows before comparing", () => {
    const value = aggregateDay("body_weight", [
      row({ type: "body_weight", value: 180, unit: "lb", recordedAt: new Date("2026-03-14T07:00:00Z") }),
    ]);
    expect(value?.value).toBeCloseTo(81.65, 2);
  });

  it("carries the secondary value for blood pressure", () => {
    const value = aggregateDay("blood_pressure", [
      row({ type: "blood_pressure", value: 118, secondaryValue: 76 }),
    ]);
    expect(value?.secondary).toBe(76);
  });
});

describe("heart rate", () => {
  it("averages samples and preserves the day's range", () => {
    const value = aggregateDay("heart_rate", [
      row({ type: "heart_rate", value: 60, minValue: 52, maxValue: 90 }),
      row({ type: "heart_rate", value: 80, minValue: 61, maxValue: 152 }),
    ]);
    expect(value?.value).toBe(70);
    expect(value?.min).toBe(52);
    expect(value?.max).toBe(152);
  });

  it("averages resting heart rate", () => {
    const value = aggregateDay("resting_hr", [
      row({ type: "resting_hr", value: 54 }),
      row({ type: "resting_hr", value: 58 }),
    ]);
    expect(value?.value).toBe(56);
  });
});

describe("sleep", () => {
  it("sums asleep stages and never counts in-bed or awake toward time asleep", () => {
    const value = aggregateDay("sleep_hours", [
      row({ type: "sleep_hours", value: 7.6, subtype: "in_bed", source: "apple_health" }),
      row({ type: "sleep_hours", value: 4.0, subtype: "core", source: "apple_health" }),
      row({ type: "sleep_hours", value: 1.5, subtype: "deep", source: "apple_health" }),
      row({ type: "sleep_hours", value: 1.2, subtype: "rem", source: "apple_health" }),
      row({ type: "sleep_hours", value: 0.4, subtype: "awake", source: "apple_health" }),
    ]);
    expect(value?.value).toBeCloseTo(6.7, 6); // 4 + 1.5 + 1.2 — not 14.7
    expect(value?.stages?.in_bed).toBe(7.6);
    expect(value?.stages?.awake).toBe(0.4);
  });

  it("falls back to in-bed time when a source has only in-bed records", () => {
    const value = aggregateDay("sleep_hours", [
      row({ type: "sleep_hours", value: 7.9, subtype: "in_bed", source: "apple_health" }),
    ]);
    expect(value?.value).toBe(7.9);
  });

  it("treats a manual entry as a plain total and picks the fullest source", () => {
    const value = aggregateDay("sleep_hours", [
      row({ type: "sleep_hours", value: 7.0, source: "manual" }),
      row({ type: "sleep_hours", value: 6.5, subtype: "core", source: "apple_health" }),
    ]);
    expect(value?.value).toBe(7.0);
  });

  it("declares which stages count as asleep", () => {
    expect(ASLEEP_STAGES).toEqual(["asleep", "core", "deep", "rem"]);
  });
});

describe("interval merging", () => {
  const HOUR = 3_600_000;

  it("unions overlapping intervals instead of double-counting them", () => {
    const merged = mergeIntervals([
      { start: 0, end: 2 * HOUR },
      { start: 1 * HOUR, end: 3 * HOUR },
      { start: 5 * HOUR, end: 6 * HOUR },
    ]);
    expect(merged).toHaveLength(2);
    expect(intervalHours(merged)).toBe(4);
  });

  it("merges touching intervals and drops empty or inverted ones", () => {
    const merged = mergeIntervals([
      { start: 0, end: HOUR },
      { start: HOUR, end: 2 * HOUR },
      { start: 3 * HOUR, end: 3 * HOUR },
      { start: 5 * HOUR, end: 4 * HOUR },
    ]);
    expect(merged).toHaveLength(1);
    expect(intervalHours(merged)).toBe(2);
  });
});

describe("aggregateDayAll / series", () => {
  it("aggregates every metric present and skips unknown types", () => {
    const all = aggregateDayAll([
      row({ type: "steps", value: 5000 }),
      row({ type: "body_weight", value: 80 }),
      row({ type: "made_up_metric", value: 12 }),
    ]);
    expect(all.get("steps")?.value).toBe(5000);
    expect(all.get("body_weight")?.value).toBe(80);
    expect(all.has("made_up_metric")).toBe(false);
  });

  it("charts null for a day with no data, never zero", () => {
    const series = aggregateSeries(
      "steps",
      [row({ type: "steps", value: 4000, date: "2026-03-14" })],
      ["2026-03-13", "2026-03-14", "2026-03-15"],
    );
    expect(series.map((point) => point.value)).toEqual([null, 4000, null]);
  });

  it("rows with unusable units are ignored rather than poisoning the day", () => {
    const value = aggregateDay("steps", [
      row({ type: "steps", value: 4000 }),
      row({ type: "steps", value: 99, unit: "furlongs" }),
    ]);
    expect(value?.value).toBe(4000);
    expect(value?.rowCount).toBe(1);
  });
});

describe("source labels", () => {
  it("labels every declared source, and only Apple Health counts as measured", () => {
    for (const [source, meta] of Object.entries(HEALTH_SOURCE_META)) {
      expect(meta.label.length, source).toBeGreaterThan(0);
      expect(meta.measured).toBe(source === "apple_health");
    }
    expect(sourceLabel("manual")).toBe("Manual");
    expect(sourceLabel("something_new")).toBe("something_new");
  });
});

describe("manual-entry validation", () => {
  it("accepts a well-formed entry with optional time and notes", () => {
    const parsed = healthMetricSchema.safeParse({
      date: "2026-03-14",
      type: "steps",
      value: 8000,
      time: "07:30",
      notes: "morning walk",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative values, bad times and unknown types", () => {
    expect(
      healthMetricSchema.safeParse({ date: "2026-03-14", type: "steps", value: -1 }).success,
    ).toBe(false);
    expect(
      healthMetricSchema.safeParse({ date: "2026-03-14", type: "steps", value: 1, time: "25:00" })
        .success,
    ).toBe(false);
    expect(
      healthMetricSchema.safeParse({ date: "2026-03-14", type: "blood_sugar", value: 1 }).success,
    ).toBe(false);
  });
});

describe("privacy — health data goes nowhere", () => {
  it("no health module performs a network request", () => {
    const roots = [
      path.join(__dirname, "../src/lib/logic/health.ts"),
      path.join(__dirname, "../src/lib/logic/health-import"),
      path.join(__dirname, "../src/server/health.ts"),
      path.join(__dirname, "../src/server/health-import.ts"),
      path.join(__dirname, "../src/server/health-import"),
      path.join(__dirname, "../src/server/actions/health.ts"),
      path.join(__dirname, "../src/server/actions/health-import.ts"),
    ];
    const files: string[] = [];
    for (const root of roots) {
      if (root.endsWith(".ts")) files.push(root);
      else for (const entry of readdirSync(root)) files.push(path.join(root, entry));
    }
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(source, `${file} must not open sockets`).not.toMatch(/node:https?|node:net|XMLHttpRequest|axios/);
    }
  });

  it("the food-provider search options have no field a health record could travel through", async () => {
    // Structural: a provider receives a limit, an abort signal and a branded
    // hint — nothing a metric, weight or user id could ride along in. The
    // constant is type-asserted against the interface, so a new field must be
    // added here too, and this test is where that addition gets questioned.
    const { SEARCH_OPTION_KEYS } = await import("@/server/providers/types");
    expect(SEARCH_OPTION_KEYS).toEqual(["limit", "signal", "preferBranded"]);
  });
});
