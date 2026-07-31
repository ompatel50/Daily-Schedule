import { describe, expect, it } from "vitest";

import {
  PLAUSIBLE_BOUNDS,
  buildIntegrityReport,
  checkFailedImports,
  checkFutureDated,
  checkImplausibleValues,
  checkMissingFingerprints,
  checkOrphanedBatchLinks,
  checkUnknownTypes,
  checkUnreadableUnits,
  type MetricExtent,
  type UnitUsage,
} from "@/lib/logic/health-import/integrity";
import { HEALTH_METRIC_TYPES } from "@/lib/enums";
import { isSupportedUnit } from "@/lib/logic/health";

/**
 * The integrity rules. Each one is a judgement about aggregate numbers, so the
 * whole point is that it can be exercised without a database — and that a rule
 * which would flag ordinary, healthy data is caught here rather than by a user
 * being told their own readings are wrong.
 */

const extent = (over: Partial<MetricExtent> = {}): MetricExtent => ({
  type: "steps",
  min: 100,
  max: 20_000,
  count: 400,
  ...over,
});

describe("unknown metric types", () => {
  it("says nothing when every stored type is one the app knows", () => {
    expect(checkUnknownTypes([extent(), extent({ type: "sleep_hours" })])).toBeNull();
  });

  it("counts rows stored under a metric with no rules, and names them", () => {
    const finding = checkUnknownTypes([
      extent(),
      extent({ type: "hk_basal_body_temperature", count: 12 }),
      extent({ type: "made_up_metric", count: 3 }),
    ]);
    expect(finding?.code).toBe("unknown_metric_type");
    expect(finding?.count).toBe(15);
    expect(finding?.severity).toBe("problem");
    expect(finding?.title).toContain("15 readings");
    expect(finding?.detail).toContain("hk_basal_body_temperature");
  });
});

describe("unreadable units", () => {
  it("passes every metric storing its own canonical unit", () => {
    // The real vocabulary, not a sample: a metric whose canonical unit its own
    // converter rejects would make every reading of it unreadable.
    const usage: UnitUsage[] = HEALTH_METRIC_TYPES.map((type) => ({
      type,
      unit: canonicalUnitOf(type),
      count: 1,
    }));
    expect(checkUnreadableUnits(usage)).toBeNull();
  });

  it("flags a unit the metric cannot convert, with an example", () => {
    const finding = checkUnreadableUnits([
      { type: "body_weight", unit: "kg", count: 100 },
      { type: "body_weight", unit: "furlongs", count: 4 },
    ]);
    expect(finding?.code).toBe("unreadable_unit");
    expect(finding?.count).toBe(4);
    expect(finding?.detail).toContain("Body weight");
    expect(finding?.detail).toContain("furlongs");
  });

  it("ignores unknown types here — they are the other check's job, not double-reported", () => {
    expect(checkUnreadableUnits([{ type: "not_a_metric", unit: "??", count: 9 }])).toBeNull();
  });
});

describe("implausible values", () => {
  it("accepts an ordinary, healthy range for every bounded metric", () => {
    // A rule that flags real data is worse than no rule: the user learns to
    // ignore the panel. Each pair below is unremarkable for its metric.
    const ordinary: MetricExtent[] = [
      extent({ type: "steps", min: 0, max: 42_000 }),
      // A well-trained athlete at rest, and a hard interval session.
      extent({ type: "resting_hr", min: 34, max: 62 }),
      extent({ type: "heart_rate", min: 38, max: 199 }),
      extent({ type: "body_weight", min: 44, max: 130 }),
      extent({ type: "body_temperature", min: 35.4, max: 40.2 }),
      extent({ type: "sleep_hours", min: 0.2, max: 11 }),
      extent({ type: "blood_oxygen", min: 88, max: 100 }),
      extent({ type: "vo2_max", min: 21, max: 71 }),
    ];
    expect(checkImplausibleValues(ordinary)).toBeNull();
  });

  it("flags a value no body produces", () => {
    const finding = checkImplausibleValues([
      extent({ type: "resting_hr", min: 48, max: 4_000 }),
    ]);
    expect(finding?.code).toBe("implausible_value");
    expect(finding?.detail).toContain("Resting");
    expect(finding?.detail).toContain("4000");
  });

  it("flags a negative reading even for a metric with no explicit bounds", () => {
    const finding = checkImplausibleValues([extent({ type: "mood", min: -3, max: 5 })]);
    expect(finding?.code).toBe("implausible_value");
  });

  it("counts metrics rather than claiming a row count it never measured", () => {
    const finding = checkImplausibleValues([
      extent({ type: "steps", min: 0, max: 900_000, count: 5_000 }),
      extent({ type: "hrv", min: -5, max: 90, count: 5_000 }),
    ]);
    // Two metrics are out of range; the 10,000 rows behind them were never
    // examined, so the count must not pretend otherwise.
    expect(finding?.count).toBe(2);
  });

  it("skips a metric with no readings at all", () => {
    expect(checkImplausibleValues([extent({ type: "steps", min: null, max: null, count: 0 })]))
      .toBeNull();
  });

  it("bounds only metrics that exist", () => {
    for (const type of Object.keys(PLAUSIBLE_BOUNDS)) {
      expect(HEALTH_METRIC_TYPES, `${type} is not a metric`).toContain(type);
    }
  });
});

describe("the simple counters", () => {
  it("report nothing at zero", () => {
    expect(checkFutureDated(0, "2026-07-31")).toBeNull();
    expect(checkMissingFingerprints(0)).toBeNull();
    expect(checkOrphanedBatchLinks(0)).toBeNull();
    expect(checkFailedImports(0)).toBeNull();
  });

  it("name the day a future reading is measured against", () => {
    const finding = checkFutureDated(3, "2026-07-31");
    expect(finding?.severity).toBe("problem");
    expect(finding?.detail).toContain("2026-07-31");
  });

  it("treat survivors of an undo as a note, not a fault — that is the intended behaviour", () => {
    expect(checkOrphanedBatchLinks(4)?.severity).toBe("note");
    expect(checkMissingFingerprints(4)?.severity).toBe("note");
    expect(checkFailedImports(1)?.severity).toBe("note");
  });
});

describe("the assembled report", () => {
  it("is clean when nothing was found, and says so", () => {
    const report = buildIntegrityReport([null, null, null]);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.problems).toBe(0);
    expect(report.notes).toBe(0);
  });

  it("puts problems before notes, and the biggest first within each", () => {
    const report = buildIntegrityReport([
      checkMissingFingerprints(900),
      checkFutureDated(2, "2026-07-31"),
      checkFailedImports(1),
      checkUnknownTypes([extent({ type: "mystery", count: 50 })]),
    ]);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "unknown_metric_type", // problem, 50
      "future_dated", // problem, 2
      "missing_fingerprint", // note, 900
      "failed_import", // note, 1
    ]);
    expect(report.problems).toBe(2);
    expect(report.notes).toBe(2);
    expect(report.clean).toBe(false);
  });
});

/** The unit a metric stores in, discovered rather than re-listed. */
function canonicalUnitOf(type: string): string {
  // Every metric must accept its own canonical unit; the aggregation module is
  // the authority on what that is, and `isSupportedUnit` is how it answers.
  for (const candidate of CANDIDATE_UNITS) {
    if (isSupportedUnit(type, candidate)) return candidate;
  }
  throw new Error(`no supported unit found for ${type}`);
}

const CANDIDATE_UNITS = [
  "",
  "kcal",
  "ml",
  "l",
  "km",
  "m",
  "h",
  "min",
  "kg",
  "g",
  "mg",
  "mcg",
  "%",
  "bpm",
  "ms",
  "mmHg",
  "/5",
  "cm",
  "count/min",
  "mL/min·kg",
  "mg/dL",
  "degC",
  "L/min",
];
