import { describe, expect, it } from "vitest";

import {
  BOOKKEEPING_CATEGORIES,
  dailyFactFromSummary,
  type DailyFactRowLike,
  financeDayFacts,
  plannerMinuteFacts,
  workoutDayFacts,
} from "@/lib/logic/daily-facts";

/**
 * The daily fact layer's pure half: folding raw rows into summary columns and
 * resolving a stored row's null semantics. The load-bearing rule under test:
 * missing data is explicitly null, never zero.
 */

function storedRow(overrides: Partial<DailyFactRowLike> = {}): DailyFactRowLike {
  return {
    date: "2026-08-01",
    plannedCount: 0,
    completedCount: 0,
    skippedCount: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
    categoryMinutes: "{}",
    habitsDue: 0,
    habitsDone: 0,
    habitsSkipped: 0,
    habitsMissed: 0,
    habitsPaused: 0,
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    mealCount: 0,
    nutritionTargetsMet: 0,
    nutritionTargetsTotal: 0,
    workoutCount: 0,
    workoutMinutes: 0,
    workoutVolumeKg: 0,
    caloriesBurned: 0,
    workoutTypes: "[]",
    dayType: null,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksDueOpen: 0,
    spendCents: 0,
    incomeCents: 0,
    transactionCount: 0,
    spendByCategory: "{}",
    steps: null,
    sleepHours: null,
    bodyWeight: null,
    restingHr: null,
    hrv: null,
    activeCalories: null,
    hydrationMl: null,
    score: 0,
    scoreApplicable: 0,
    scoreCompleted: 0,
    scoreMissed: 0,
    scorePending: 0,
    scoreExcluded: 0,
    hasJournal: false,
    ...overrides,
  };
}

describe("dailyFactFromSummary null semantics", () => {
  it("reads an unlogged nutrition day as null, never zero", () => {
    const fact = dailyFactFromSummary(storedRow({ mealCount: 0, calories: 0, protein: 0 }));
    expect(fact.calories).toBeNull();
    expect(fact.protein).toBeNull();
    expect(fact.carbs).toBeNull();
    expect(fact.fat).toBeNull();
    expect(fact.fiber).toBeNull();
    expect(fact.mealCount).toBe(0); // the count itself is a true zero
  });

  it("keeps real macros once a meal exists — including a genuinely zero one", () => {
    const fact = dailyFactFromSummary(
      storedRow({ mealCount: 2, calories: 1850, protein: 120, fiber: 31 }),
    );
    expect(fact.calories).toBe(1850);
    expect(fact.fiber).toBe(31);

    // A logged day summing to 0 kcal (water-only entries) is a real 0.
    const zeroDay = dailyFactFromSummary(storedRow({ mealCount: 1, calories: 0 }));
    expect(zeroDay.calories).toBe(0);
  });

  it("reads a day with nothing scoreable as score null, not 0", () => {
    expect(dailyFactFromSummary(storedRow({ score: 0, scoreApplicable: 0 })).score).toBeNull();
    expect(dailyFactFromSummary(storedRow({ score: 0, scoreApplicable: 3 })).score).toBe(0);
    expect(dailyFactFromSummary(storedRow({ score: 80, scoreApplicable: 5 })).score).toBe(80);
  });

  it("reads target adherence as null when no targets applied", () => {
    expect(dailyFactFromSummary(storedRow()).targetAdherence).toBeNull();
    expect(
      dailyFactFromSummary(storedRow({ nutritionTargetsMet: 2, nutritionTargetsTotal: 4 }))
        .targetAdherence,
    ).toBe(0.5);
  });

  it("passes nullable health metrics through untouched", () => {
    const fact = dailyFactFromSummary(storedRow({ steps: 8200, restingHr: null, hrv: 64 }));
    expect(fact.steps).toBe(8200);
    expect(fact.restingHr).toBeNull();
    expect(fact.hrv).toBe(64);
  });

  it("accepts only known day types; pre-upgrade rows read null", () => {
    expect(dailyFactFromSummary(storedRow({ dayType: "training" })).dayType).toBe("training");
    expect(dailyFactFromSummary(storedRow({ dayType: "rest" })).dayType).toBe("rest");
    expect(dailyFactFromSummary(storedRow({ dayType: null })).dayType).toBeNull();
    expect(dailyFactFromSummary(storedRow({ dayType: "banana" })).dayType).toBeNull();
  });

  it("parses JSON columns defensively — a corrupt cell degrades to empty", () => {
    const fact = dailyFactFromSummary(
      storedRow({
        categoryMinutes: "not json",
        spendByCategory: '{"food": "NaN-ish", "rent": 120000}',
        workoutTypes: '["push", 3, "run"]',
      }),
    );
    expect(fact.categoryMinutes).toEqual({});
    expect(fact.spendByCategory).toEqual({ rent: 120000 }); // non-numbers dropped
    expect(fact.workoutTypes).toEqual(["push", "run"]); // non-strings dropped
  });

  it("keeps counts as true zeros — 'nothing happened' is a fact for them", () => {
    const fact = dailyFactFromSummary(storedRow());
    expect(fact.tasksCreated).toBe(0);
    expect(fact.transactionCount).toBe(0);
    expect(fact.habitsDue).toBe(0);
    expect(fact.plannedCount).toBe(0);
  });
});

describe("plannerMinuteFacts", () => {
  const block = (
    startMinute: number | null,
    endMinute: number | null,
    status = "planned",
    category = "deep_work",
    allDay = false,
  ) => ({ status, allDay, startMinute, endMinute, category });

  it("sums timed minutes into planned and completed buckets", () => {
    const facts = plannerMinuteFacts([
      block(540, 600, "done"), // 60 min done
      block(600, 630, "planned"), // 30 min pending
    ]);
    expect(facts.plannedMinutes).toBe(90);
    expect(facts.completedMinutes).toBe(60);
    expect(facts.categoryMinutes).toEqual({ deep_work: 90 });
  });

  it("measures a cross-midnight block by the shared span math", () => {
    // 11:45 PM → 12:15 AM = 30 minutes, not −1410.
    const facts = plannerMinuteFacts([block(1425, 15, "done")]);
    expect(facts.plannedMinutes).toBe(30);
    expect(facts.completedMinutes).toBe(30);
  });

  it("skips all-day, unbounded, zero-length and skipped blocks", () => {
    const facts = plannerMinuteFacts([
      block(540, 600, "planned", "chores", true), // all-day: counted elsewhere, never summed
      block(null, null), // untimed
      block(540, 540), // zero-length point item
      block(540, 600, "skipped"), // skipped carries no minutes
    ]);
    expect(facts.plannedMinutes).toBe(0);
    expect(facts.categoryMinutes).toEqual({});
  });

  it("splits category minutes by category", () => {
    const facts = plannerMinuteFacts([
      block(540, 600, "done", "deep_work"),
      block(660, 690, "planned", "admin"),
      block(700, 760, "planned", "deep_work"),
    ]);
    expect(facts.categoryMinutes).toEqual({ deep_work: 120, admin: 30 });
  });
});

describe("financeDayFacts", () => {
  it("splits spend and income by sign, in magnitudes", () => {
    const facts = financeDayFacts([
      { category: "food", amountCents: -1250 },
      { category: "food", amountCents: -750 },
      { category: "salary", amountCents: 500000 },
    ]);
    expect(facts.spendCents).toBe(2000);
    expect(facts.incomeCents).toBe(500000);
    expect(facts.transactionCount).toBe(3);
    expect(facts.spendByCategory).toEqual({ food: 2000 });
  });

  it("excludes bookkeeping categories from both totals but not the count", () => {
    expect(BOOKKEEPING_CATEGORIES.has("transfer")).toBe(true);
    expect(BOOKKEEPING_CATEGORIES.has("adjustment")).toBe(true);
    const facts = financeDayFacts([
      { category: "transfer", amountCents: -100000 },
      { category: "adjustment", amountCents: 4200 },
      { category: "food", amountCents: -900 },
    ]);
    expect(facts.spendCents).toBe(900);
    expect(facts.incomeCents).toBe(0);
    expect(facts.transactionCount).toBe(3);
    expect(facts.spendByCategory).toEqual({ food: 900 });
  });

  it("reads an empty ledger as true zeros (untracked is a HISTORY question)", () => {
    const facts = financeDayFacts([]);
    expect(facts).toEqual({
      spendCents: 0,
      incomeCents: 0,
      transactionCount: 0,
      spendByCategory: {},
    });
  });
});

describe("workoutDayFacts", () => {
  it("sums volume over completed sets only", () => {
    const facts = workoutDayFacts([
      {
        type: "strength",
        sets: [
          { reps: 8, weightKg: 100, completed: true },
          { reps: 8, weightKg: 100, completed: true },
          { reps: 8, weightKg: 100, completed: false }, // planned, never lifted
        ],
      },
    ]);
    expect(facts.workoutVolumeKg).toBe(1600);
  });

  it("treats bodyweight sets as zero volume without inventing a weight", () => {
    const facts = workoutDayFacts([
      { type: "calisthenics", sets: [{ reps: 12, weightKg: null, completed: true }] },
    ]);
    expect(facts.workoutVolumeKg).toBe(0);
  });

  it("collects distinct types in first-seen order", () => {
    const facts = workoutDayFacts([
      { type: "run", sets: [] },
      { type: "strength", sets: [{ reps: 5, weightKg: 60, completed: true }] },
      { type: "run", sets: [] },
    ]);
    expect(facts.workoutTypes).toEqual(["run", "strength"]);
    expect(facts.workoutVolumeKg).toBe(300);
  });
});
