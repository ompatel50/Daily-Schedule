import { describe, expect, it } from "vitest";

import { shiftDay } from "@/lib/date";
import type { DailyFact } from "@/lib/logic/daily-facts";
import {
  CORRELATION_CANDIDATES,
  CORRELATION_FDR,
  CORRELATION_VARIABLES,
  MIN_PAIRED_OBSERVATIONS,
  benjaminiHochberg,
  computeCorrelations,
  describeEvidence,
  describeFinding,
  describeSplit,
  spearman,
  twoTailedTProbability,
} from "@/lib/logic/correlations";

/**
 * The correlation engine's honesty rules, pinned against reference values
 * computed with scipy (spearmanr / t.sf) — the statistics must match the
 * standard implementations, not merely look plausible.
 */

// A 40-day sample with a real monotonic association (scipy: ρ = 0.78975,
// p = 1.382e-9).
const SLEEP_40 = [
  7.0, 7.4, 6.7, 5.9, 6.5, 5.8, 7.1, 8.6, 6.4, 6.3, 7.6, 7.4, 7.1, 5.9, 7.0, 7.8, 5.4, 6.5,
  4.7, 5.5, 4.8, 6.7, 5.5, 7.3, 7.2, 6.8, 4.0, 6.4, 6.9, 7.1, 5.2, 6.4, 5.8, 6.0, 8.3, 6.0,
  7.0, 8.1, 6.3, 6.9,
];
const SCORE_40 = [
  61, 64, 50, 52, 64, 41, 66, 74, 51, 66, 69, 56, 61, 55, 59, 70, 47, 60, 50, 44, 44, 55, 49,
  55, 58, 57, 41, 62, 51, 56, 49, 43, 48, 51, 78, 56, 58, 67, 53, 68,
];

// 35 days of independent noise that HAPPENS to correlate at raw p ≈ 0.020
// (scipy: ρ = −0.39036, p = 0.02043) — the case multiple-comparison
// correction exists to kill.
const NOISE_X_35 = [
  466, 476, 528, 490, 484, 411, 499, 465, 593, 552, 498, 553, 473, 584, 500, 547, 397, 528,
  365, 337, 476, 428, 513, 680, 433, 450, 516, 539, 486, 484, 556, 542, 417, 494, 503,
];
const NOISE_Y_35 = [
  34, 54, 37, 65, 53, 51, 41, 48, 20, 33, 55, 18, 63, 24, 61, 37, 62, 52, 27, 69, 72, 49, 46,
  48, 35, 66, 42, 49, 38, 41, 31, 69, 48, 64, 50,
];

describe("spearman against scipy", () => {
  it("matches on a clean ranking", () => {
    const result = spearman([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 1, 4, 3, 6, 5, 8, 7, 10, 9]);
    expect(result.rho).toBeCloseTo(0.9393939393939393, 10);
    expect(result.p).toBeCloseTo(5.4840529985136686e-5, 9);
  });

  it("matches with average-rank ties", () => {
    const result = spearman([1, 2, 2, 3, 4, 4, 4, 5], [3, 1, 2, 5, 4, 6, 7, 8]);
    expect(result.rho).toBeCloseTo(0.8470243628419076, 10);
    expect(result.p).toBeCloseTo(0.007954270632103374, 8);
  });

  it("matches on the 40-day fixture", () => {
    const result = spearman(SLEEP_40, SCORE_40);
    expect(result.rho).toBeCloseTo(0.7897457596013406, 10);
    expect(result.p / 1.3821590915263161e-9).toBeCloseTo(1, 3);
  });

  it("reports no evidence for constant or tiny series", () => {
    expect(spearman([5, 5, 5, 5, 5], [1, 2, 3, 4, 5])).toMatchObject({ rho: 0, p: 1 });
    expect(spearman([1, 2], [2, 1])).toMatchObject({ rho: 0, p: 1 });
  });
});

describe("t-distribution tail", () => {
  it("matches scipy's two-tailed probability", () => {
    expect(twoTailedTProbability(3.06, 28)).toBeCloseTo(0.004839889979554455, 10);
    expect(twoTailedTProbability(0, 28)).toBeCloseTo(1, 10);
  });
});

describe("Benjamini–Hochberg", () => {
  it("matches the standard adjusted p-values", () => {
    const ps = [
      0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216, 0.222, 0.251,
      0.269, 0.275, 0.34, 0.341, 0.384, 0.569, 0.594, 0.696, 0.762, 0.94, 0.942, 0.975, 0.986,
    ];
    const qs = benjaminiHochberg(ps);
    expect(qs[0]).toBeCloseTo(0.025, 6);
    expect(qs[1]).toBeCloseTo(0.1, 6);
    expect(qs[2]).toBeCloseTo(0.21, 6);
    expect(qs[3]).toBeCloseTo(0.21, 6);
    expect(qs[4]).toBeCloseTo(0.21, 6);
    expect(qs[5]).toBeCloseTo(0.25, 6);
    // A raw p of 0.039 would have "surfaced" uncorrected; its q of 0.21 must not.
    expect(qs[2]).toBeGreaterThan(CORRELATION_FDR);
  });

  it("handles the empty and single cases", () => {
    expect(benjaminiHochberg([])).toEqual([]);
    expect(benjaminiHochberg([0.03])).toEqual([0.03]);
  });
});

// --- the engine over DailyFact records ---------------------------------------

const START = "2026-01-01";

/** A fact with nothing measured: counts zero, measurements null. */
function emptyFact(date: string): DailyFact {
  return {
    date,
    plannedCount: 0,
    completedCount: 0,
    skippedCount: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
    categoryMinutes: {},
    habitsDue: 0,
    habitsDone: 0,
    habitsSkipped: 0,
    habitsMissed: 0,
    habitsPaused: 0,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    fiber: null,
    mealCount: 0,
    targetAdherence: null,
    workoutCount: 0,
    workoutMinutes: 0,
    workoutVolumeKg: 0,
    caloriesBurned: 0,
    workoutTypes: [],
    dayType: null,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksDueOpen: 0,
    spendCents: 0,
    incomeCents: 0,
    transactionCount: 0,
    spendByCategory: {},
    steps: null,
    sleepHours: null,
    bodyWeight: null,
    restingHr: null,
    hrv: null,
    activeCalories: null,
    hydrationMl: null,
    score: null,
    scoreApplicable: 0,
    scoreCompleted: 0,
    scoreMissed: 0,
    scorePending: 0,
    scoreExcluded: 0,
    hasJournal: false,
  };
}

function factsFrom(build: (index: number, date: string) => Partial<DailyFact>, days: number) {
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDay(START, index);
    return { ...emptyFact(date), ...build(index, date) };
  });
}

function windowOf(days: number) {
  return { from: START, to: shiftDay(START, days - 1) };
}

describe("computeCorrelations", () => {
  it("surfaces a real association with effect size, split and links intact", () => {
    const facts = factsFrom(
      (index) => ({
        sleepHours: SLEEP_40[index],
        score: SCORE_40[index],
        scoreApplicable: 3,
      }),
      40,
    );
    const report = computeCorrelations(facts, windowOf(40));

    const finding = report.findings.find((entry) => entry.id === "sleep-score");
    expect(finding).toBeDefined();
    expect(finding?.n).toBe(40);
    expect(finding?.rho).toBeCloseTo(0.79, 2); // the effect size is reported
    expect(finding?.direction).toBe("positive");
    expect(finding?.strength).toBe("strong");
    expect(finding?.split.kind).toBe("median");
    if (finding?.split.kind === "median") {
      expect(finding.split.highMean).toBeGreaterThan(finding.split.lowMean);
      expect(finding.split.highDays + finding.split.lowDays).toBe(40);
    }
    // Both variables carry a link to the underlying data.
    expect(CORRELATION_VARIABLES[finding!.x].href).toBe("/health");
    expect(CORRELATION_VARIABLES[finding!.y].href).toBe("/calendar");
  });

  it("holds a pair below the observation floor as pending, never as a finding", async () => {
    const facts = factsFrom(
      (index) => ({
        sleepHours: SLEEP_40[index % SLEEP_40.length],
        score: SCORE_40[index % SCORE_40.length],
        scoreApplicable: 3,
      }),
      MIN_PAIRED_OBSERVATIONS - 1, // 29 paired days: one short
    );
    const report = computeCorrelations(facts, windowOf(MIN_PAIRED_OBSERVATIONS - 1));
    expect(report.findings).toHaveLength(0);
    const pending = report.pending.find((entry) => entry.id === "sleep-score");
    expect(pending?.n).toBe(MIN_PAIRED_OBSERVATIONS - 1);
    expect(pending?.needed).toBe(1);
  });

  it("drops days where either side is missing — never imputes", () => {
    const facts = factsFrom((index) => {
      const measured = index % 2 === 0; // sleep known every other day only
      return {
        sleepHours: measured ? SLEEP_40[index % SLEEP_40.length] : null,
        score: SCORE_40[index % SCORE_40.length],
        scoreApplicable: 3,
      };
    }, 80);
    const report = computeCorrelations(facts, windowOf(80));
    const finding = report.findings.find((entry) => entry.id === "sleep-score");
    expect(finding?.n).toBe(40); // only the measured days pair up
  });

  it("kills a spurious raw-p association through the correction", () => {
    // sleep–score is pure noise at raw p ≈ 0.020; the constant planner
    // pairs (ρ = 0, p = 1) join the tested set, so m = 3 and the noise
    // pair's q = 0.020 × 3 = 0.061 — over the FDR, suppressed entirely.
    const facts = factsFrom(
      (index) => ({
        sleepHours: index < 35 ? NOISE_X_35[index] : null,
        score: index < 35 ? NOISE_Y_35[index] : null,
        scoreApplicable: index < 35 ? 3 : 0,
      }),
      40,
    );
    const report = computeCorrelations(facts, windowOf(40));
    expect(report.tested).toBeGreaterThanOrEqual(2);
    expect(report.findings).toHaveLength(0); // suppressed, not hedged
  });

  it("pairs a lagged candidate against the previous day and skips gaps", () => {
    // Steps on day D, sleep credited to D+1 — both monotonic, so the lagged
    // pair is a certain finding and its n exposes the pairing. A gap at
    // index 20 (no fact at all) must drop BOTH surrounding pairs, not
    // misalign them.
    const facts = factsFrom(
      (index) => ({
        steps: 4000 + index * 100,
        sleepHours: 5 + index * 0.05,
      }),
      45,
    ).filter((fact) => fact.date !== shiftDay(START, 20));

    const report = computeCorrelations(facts, windowOf(45));
    const stepsSleep = report.findings.find((entry) => entry.id === "steps-sleep-next");
    // 44 facts remain; the first day has no yesterday and the day after the
    // gap has none either → 42 pairs.
    expect(stepsSleep?.n).toBe(42);
    expect(stepsSleep?.direction).toBe("positive");
  });

  it("refuses a near-constant pair — one active day among zeros is not a pattern", () => {
    // 39 days of (0 planned, 0 tasks) plus one day of (60, 3): naive rank
    // correlation reads ρ = 1 from that single joint deviation. It must
    // never surface.
    const facts = factsFrom(
      (index) => ({
        plannedMinutes: index === 5 ? 60 : 0,
        tasksCompleted: index === 5 ? 3 : 0,
      }),
      40,
    );
    const report = computeCorrelations(facts, windowOf(40));
    expect(report.findings.find((entry) => entry.id === "load-tasks")).toBeUndefined();
    // Still counted as tested — the days exist; they just carry no evidence.
    expect(report.pending.find((entry) => entry.id === "load-tasks")).toBeUndefined();
    expect(report.tested).toBeGreaterThan(0);
  });

  it("reports every candidate as pending on an empty history", () => {
    const report = computeCorrelations([], windowOf(0));
    expect(report.findings).toHaveLength(0);
    expect(report.tested).toBe(0);
    expect(report.pending).toHaveLength(CORRELATION_CANDIDATES.length);
    for (const pending of report.pending) {
      expect(pending.n).toBe(0);
      expect(pending.needed).toBe(MIN_PAIRED_OBSERVATIONS);
    }
  });

  it("treats binary training days as group means over the same pairs", () => {
    const facts = factsFrom((index) => {
      const training = index % 2 === 0;
      return {
        dayType: training ? "training" : "rest",
        habitsDue: 4,
        // Habit completion clearly higher on training days.
        habitsDone: training ? 4 : 1 + (index % 2),
      };
    }, 40);
    const report = computeCorrelations(facts, windowOf(40));
    const finding = report.findings.find((entry) => entry.id === "training-habits");
    expect(finding).toBeDefined();
    expect(finding?.split.kind).toBe("binary");
    if (finding?.split.kind === "binary") {
      expect(finding.split.highLabel).toBe("training");
      expect(finding.split.highMean).toBeGreaterThan(finding.split.lowMean);
      expect(finding.split.highDays).toBe(20);
    }
  });
});

describe("correlational language", () => {
  it("describes findings without causal or prescriptive phrasing", () => {
    const facts = factsFrom(
      (index) => ({
        sleepHours: SLEEP_40[index],
        score: SCORE_40[index],
        scoreApplicable: 3,
      }),
      40,
    );
    const report = computeCorrelations(facts, windowOf(40));
    const finding = report.findings.find((entry) => entry.id === "sleep-score")!;

    const headline = describeFinding(finding);
    const split = describeSplit(finding);
    const evidence = describeEvidence(finding, report.windowDays);

    expect(headline).toBe("Sleep and day score moved together");
    expect(split).toMatch(/averaged/);
    expect(evidence).toContain("40 paired days");
    expect(evidence).toContain("last 180 days");
    expect(evidence).toContain("ρ = +0.79");

    for (const text of [headline, split ?? "", evidence]) {
      expect(text).not.toMatch(/because|causes|leads to|improves|should|try to|makes you/i);
    }
  });
});
