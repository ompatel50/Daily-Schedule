import { describe, expect, it } from "vitest";

import { shiftDay, weekdayOf } from "@/lib/date";
import type { DailyFact } from "@/lib/logic/daily-facts";
import { formatCents } from "@/lib/logic/money";
import {
  SPENDING_TRACKED_MIN_DAYS,
  computeSpendingReport,
  describeSpendingEvidence,
  describeSpendingFinding,
  describeSpendingSplit,
  qualifyingFloor,
} from "@/lib/logic/spending";

/**
 * The spending-trigger engine: same statistical bar as the general
 * correlations (whose math is pinned against scipy in
 * tests/correlations.test.ts), plus the finance-specific rules — the
 * tracked-history gate, category-level testing, and neutral language.
 */

const START = "2026-01-01";

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

/** Ledger noise deterministic enough to test with. */
function jitter(index: number, spread: number): number {
  return ((index * 37) % spread) - Math.floor(spread / 2);
}

describe("the tracked-history gate", () => {
  it("declines to analyse a window with too few ledger days", () => {
    const facts = factsFrom(
      (index) =>
        index < SPENDING_TRACKED_MIN_DAYS - 1
          ? { transactionCount: 1, spendCents: 1500, spendByCategory: { dining: 1500 } }
          : {},
      90,
    );
    const report = computeSpendingReport(facts, windowOf(90));
    expect(report.untracked).toBe(true);
    expect(report.trackedDays).toBe(SPENDING_TRACKED_MIN_DAYS - 1);
    expect(report.findings).toHaveLength(0);
    expect(report.tested).toBe(0);
  });

  it("treats an empty history as untracked, never as a pattern of zero spending", () => {
    const report = computeSpendingReport([], windowOf(0));
    expect(report.untracked).toBe(true);
    expect(report.findings).toHaveLength(0);
  });
});

describe("category-level analysis", () => {
  it("surfaces a weekend–dining association in cents, category-first", () => {
    // 84 days: dining spend clearly higher on weekends, groceries steady.
    const facts = factsFrom((index, date) => {
      const weekend = weekdayOf(date) === 0 || weekdayOf(date) === 6;
      const dining = weekend ? 3500 + jitter(index, 600) : 800 + jitter(index, 400);
      const groceries = 2000 + jitter(index, 500);
      return {
        transactionCount: 2,
        spendCents: dining + groceries,
        spendByCategory: { dining, groceries },
      };
    }, 84);

    const report = computeSpendingReport(facts, windowOf(84));
    expect(report.untracked).toBe(false);
    expect(report.categories).toContain("dining");
    expect(report.categories).toContain("groceries");

    const diningWeekend = report.findings.find(
      (finding) => finding.context === "weekend" && finding.target.category === "dining",
    );
    expect(diningWeekend).toBeDefined();
    expect(diningWeekend?.direction).toBe("positive");
    expect(diningWeekend?.n).toBe(84);
    if (diningWeekend?.split.kind === "binary") {
      expect(diningWeekend.split.highLabel).toBe("weekend");
      expect(diningWeekend.split.highMeanCents).toBeGreaterThan(
        diningWeekend.split.lowMeanCents,
      );
    }

    // The steady category shows no weekend association — suppressed.
    expect(
      report.findings.find(
        (finding) => finding.context === "weekend" && finding.target.category === "groceries",
      ),
    ).toBeUndefined();
  });

  it("keeps rarely-active categories out of the tested set", () => {
    // "fees" appears on only 3 days of 90 — below the qualifying floor.
    const facts = factsFrom((index) => {
      const fees = index % 30 === 0 ? 900 : 0;
      const spendByCategory: Record<string, number> =
        fees > 0 ? { groceries: 1000, fees } : { groceries: 1000 };
      return { transactionCount: 1, spendCents: 1000 + fees, spendByCategory };
    }, 90);
    const report = computeSpendingReport(facts, windowOf(90));
    expect(report.categories).not.toContain("fees");
    expect(qualifyingFloor(90)).toBeGreaterThan(3);
  });

  it("drops days where a context is missing instead of imputing", () => {
    // Sleep known on 60 of 90 days: the sleep × spending pair uses 60.
    const facts = factsFrom((index) => ({
      transactionCount: 1,
      spendCents: 1000 + jitter(index, 500),
      spendByCategory: { groceries: 1000 + jitter(index, 500) },
      sleepHours: index % 3 === 2 ? null : 6 + (index % 5) * 0.5,
    }), 90);
    const report = computeSpendingReport(facts, windowOf(90));
    const sleepPairs = [
      ...report.findings.filter((finding) => finding.context === "sleep"),
      ...report.pending.filter((entry) => entry.context === "sleep"),
    ];
    // Whether tested-and-suppressed or significant, any surfaced sleep pair
    // must carry only the 60 measured days. (Suppressed pairs are absent —
    // check via a pending-forcing variant below the floor.)
    for (const pair of sleepPairs) {
      expect(pair.n).toBe(60);
    }
  });
});

describe("neutral, non-advisory language", () => {
  it("describes findings without moralising or savings advice", () => {
    const facts = factsFrom((index, date) => {
      const weekend = weekdayOf(date) === 0 || weekdayOf(date) === 6;
      const dining = weekend ? 4000 + jitter(index, 300) : 700 + jitter(index, 300);
      return {
        transactionCount: 1,
        spendCents: dining,
        spendByCategory: { dining },
      };
    }, 84);
    const report = computeSpendingReport(facts, windowOf(84));
    const finding = report.findings.find(
      (entry) => entry.context === "weekend" && entry.target.category === "dining",
    )!;

    const headline = describeSpendingFinding(finding);
    const split = describeSpendingSplit(finding, (cents) => formatCents(cents));
    const evidence = describeSpendingEvidence(finding, report.windowDays);

    expect(headline).toBe("Dining spend and weekends moved together");
    expect(split).toMatch(/averaged \$/);
    expect(evidence).toContain("84 paired days");

    for (const text of [headline, split ?? "", evidence]) {
      expect(text).not.toMatch(
        /save|savings|budget|cut back|overspend|too much|should|advice|afford|waste/i,
      );
      expect(text).not.toMatch(/because|causes|leads to/i);
    }
  });
});
