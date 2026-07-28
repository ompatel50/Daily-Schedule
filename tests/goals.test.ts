import { describe, expect, it } from "vitest";

import {
  buildGoalEvaluation,
  describeGoalTarget,
  emptyFacts,
  evaluateGoal,
  isWeeklyGoal,
  measureGoal,
  type GoalFacts,
  type GoalLike,
} from "@/lib/logic/goals";
import {
  calculateScheduledStreak,
  calculateWeeklyProgress,
  getOccurrenceForDate,
  getStatusForDate,
  type ScheduleRuleLike,
  type ScheduleSettings,
  type SchedulableItem,
} from "@/lib/logic/schedule";

const MON = "2026-03-02";
const TUE = "2026-03-03";
const WED = "2026-03-04";
const THU = "2026-03-05";
const FRI = "2026-03-06";
const SUN = "2026-03-08";

function settings(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return { weekStartsOn: 1, timezone: "America/New_York", today: SUN, ...overrides };
}

function rule(overrides: Partial<ScheduleRuleLike> = {}): ScheduleRuleLike {
  return {
    id: "rule-1",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    mode: "every_day",
    interval: 1,
    timesPerWeek: null,
    monthDay: null,
    enabled: true,
    daypart: "anytime",
    timeMinute: null,
    reminderEnabled: false,
    reminderMinute: null,
    weekdays: [],
    ...overrides,
  };
}

function item(overrides: Partial<SchedulableItem> = {}): SchedulableItem {
  return { id: "goal-1", startDate: null, endDate: null, enabled: true, rules: [rule()], overrides: [], ...overrides };
}

function goal(overrides: Partial<GoalLike> = {}): GoalLike {
  return {
    id: "goal-1",
    label: "Test goal",
    domain: "health",
    metric: "test",
    target: 1,
    targetMax: null,
    unit: "",
    direction: "gte",
    period: "daily",
    source: "manual",
    sourceRef: null,
    ...overrides,
  };
}

function facts(overrides: Partial<GoalFacts> = {}): GoalFacts {
  return { ...emptyFacts(), ...overrides };
}

describe("comparison methods", () => {
  it("at least: partial progress is proportional and capped", () => {
    const protein = goal({ target: 160, unit: "g", direction: "gte", source: "protein" });
    expect(evaluateGoal(protein, { value: 120, hasData: true }).progress).toBeCloseTo(0.75);
    expect(evaluateGoal(protein, { value: 120, hasData: true }).met).toBe(false);
    expect(evaluateGoal(protein, { value: 200, hasData: true }).met).toBe(true);
    expect(evaluateGoal(protein, { value: 200, hasData: true }).progress).toBe(1);
  });

  it("at most: met under the ceiling, tapering above it", () => {
    const calories = goal({ target: 2200, unit: "kcal", direction: "lte", source: "calories" });
    expect(evaluateGoal(calories, { value: 2000, hasData: true }).met).toBe(true);
    expect(evaluateGoal(calories, { value: 2200, hasData: true }).met).toBe(true);
    const over = evaluateGoal(calories, { value: 2640, hasData: true });
    expect(over.met).toBe(false);
    expect(over.progress).toBeCloseTo(0.8);
    expect(evaluateGoal(calories, { value: 6000, hasData: true }).progress).toBe(0);
  });

  it("within a range: met between the bounds", () => {
    const window = goal({ target: 2000, targetMax: 2300, direction: "range", source: "calories" });
    expect(evaluateGoal(window, { value: 2150, hasData: true }).met).toBe(true);
    expect(evaluateGoal(window, { value: 2000, hasData: true }).met).toBe(true);
    expect(evaluateGoal(window, { value: 2300, hasData: true }).met).toBe(true);
    expect(evaluateGoal(window, { value: 1900, hasData: true }).met).toBe(false);
    expect(evaluateGoal(window, { value: 2400, hasData: true }).met).toBe(false);
  });

  it("exactly: only the precise value counts", () => {
    const exact = goal({ target: 3, direction: "eq" });
    expect(evaluateGoal(exact, { value: 3, hasData: true }).met).toBe(true);
    expect(evaluateGoal(exact, { value: 4, hasData: true }).met).toBe(false);
  });

  it("completed / not completed stays binary", () => {
    const binary = goal({ target: 1, direction: "boolean" });
    expect(evaluateGoal(binary, { value: 1, hasData: true })).toEqual({ met: true, progress: 1, hasData: true });
    expect(evaluateGoal(binary, { value: 0, hasData: true })).toEqual({ met: false, progress: 0, hasData: true });
  });

  it("missing data is not a failure — progress is null, not zero", () => {
    const protein = goal({ target: 160, source: "protein" });
    const outcome = evaluateGoal(protein, { value: null, hasData: false });
    expect(outcome.hasData).toBe(false);
    expect(outcome.progress).toBeNull();
    expect(outcome.met).toBe(false);
  });
});

describe("completion sources read from data the app already has", () => {
  it("a workout goal is settled by completed workouts", () => {
    const workoutGoal = goal({ source: "workout_count", target: 1, direction: "gte" });
    expect(evaluateGoal(workoutGoal, measureGoal(workoutGoal, facts({ workoutCount: 1 }))).met).toBe(true);
    expect(evaluateGoal(workoutGoal, measureGoal(workoutGoal, facts({ workoutCount: 0 }))).met).toBe(false);
  });

  it("a workout-minutes goal reads the summed duration", () => {
    const minutes = goal({ source: "workout_minutes", target: 45, unit: "min" });
    const measurement = measureGoal(minutes, facts({ workoutMinutes: 52 }));
    expect(measurement.value).toBe(52);
    expect(evaluateGoal(minutes, measurement).met).toBe(true);
  });

  it("a protein goal reads logged meals and distinguishes unlogged from zero", () => {
    const protein = goal({ source: "protein", target: 160, unit: "g" });
    expect(measureGoal(protein, facts({ protein: 170 })).value).toBe(170);
    expect(measureGoal(protein, facts()).hasData).toBe(false);
    expect(measureGoal(protein, facts({ protein: 0 })).hasData).toBe(true);
  });

  it("a habit-linked goal is settled by the habit log", () => {
    const linked = goal({ source: "habit", sourceRef: "habit-9", direction: "boolean" });
    expect(evaluateGoal(linked, measureGoal(linked, facts({ habitsDone: new Set(["habit-9"]) }))).met).toBe(true);
    expect(evaluateGoal(linked, measureGoal(linked, facts({ habitsDone: new Set(["other"]) }))).met).toBe(false);
  });

  it("a planner goal counts required items only when there were any", () => {
    const planner = goal({ source: "planner_required", target: 3 });
    expect(measureGoal(planner, facts({ plannerRequired: 0, plannerRequiredDone: 0 })).hasData).toBe(false);
    expect(measureGoal(planner, facts({ plannerRequired: 4, plannerRequiredDone: 3 })).value).toBe(3);
  });

  it("a manual goal falls back to its own entry", () => {
    const manual = goal({ source: "manual", direction: "boolean" });
    const withEntry = facts({ manual: new Map([["goal-1", { status: "done", value: null }]]) });
    expect(evaluateGoal(manual, measureGoal(manual, withEntry)).met).toBe(true);
    expect(measureGoal(manual, facts()).hasData).toBe(false);
  });

  it("does not double-count one workout across the same goal", () => {
    // Two evaluations of the same day's facts must give the same number.
    const workoutGoal = goal({ source: "workout_count", target: 1 });
    const day = facts({ workoutCount: 1 });
    expect(measureGoal(workoutGoal, day).value).toBe(1);
    expect(measureGoal(workoutGoal, day).value).toBe(1);
  });
});

describe("the Mon/Tue/Thu/Fri workout goal", () => {
  const config = settings({ today: SUN });
  const schedule = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] })] });
  const workoutGoal = goal({ label: "Workout", source: "workout_count", target: 1, direction: "gte" });

  it("is inactive on Wednesday and reads as a rest day, not a miss", () => {
    const occurrence = getOccurrenceForDate(schedule, WED, config);
    expect(occurrence.active).toBe(false);
    expect(occurrence.counts).toBe(false);

    const evaluation = buildGoalEvaluation({
      goal: workoutGoal,
      date: WED,
      occurrence,
      status: getStatusForDate(schedule, WED, null, config).status,
      facts: facts({ workoutCount: 0 }),
      weekFacts: facts(),
      weekly: null,
      settings: config,
    });

    expect(evaluation.applicable).toBe(false);
    expect(evaluation.status).toBe("not_scheduled");
    expect(evaluation.summary).toBe("Not scheduled today");
    // Crucially: never "0 of 1 workout", never "missed".
    expect(evaluation.summary).not.toContain("0 of 1");
    expect(evaluation.summary).not.toContain("Missed");
  });

  it("does not break the streak when Wednesday is skipped over", () => {
    const completions = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
      { date: THU, status: "done" },
      { date: FRI, status: "done" },
    ];
    const result = calculateScheduledStreak(schedule, FRI, completions, settings({ today: FRI }));
    expect(result.current).toBe(4);
  });

  it("does break the streak when a scheduled Thursday is missed", () => {
    const completions = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
      // Thursday missed
      { date: FRI, status: "done" },
    ];
    const result = calculateScheduledStreak(schedule, FRI, completions, settings({ today: FRI }));
    expect(result.current).toBe(1);
  });

  it("is a real requirement on Thursday", () => {
    expect(getOccurrenceForDate(schedule, THU, config).active).toBe(true);
  });
});

describe("weekly goals", () => {
  const config = settings({ today: THU });
  const fourPerWeek = item({ rules: [rule({ mode: "times_per_week", timesPerWeek: 4 })] });
  const weeklyGoal = goal({ label: "4 workouts", source: "workout_count", target: 4, period: "weekly" });

  it("is recognised as weekly by either the period or the schedule", () => {
    const flexible = getOccurrenceForDate(fourPerWeek, THU, config);
    expect(isWeeklyGoal(weeklyGoal, flexible)).toBe(true);
    expect(isWeeklyGoal(goal({ period: "daily" }), flexible)).toBe(true); // times-per-week schedule
  });

  it("reports 3 of 4 with 75% and one remaining", () => {
    const completions = [MON, TUE, WED].map((date) => ({ date, status: "done" }));
    const weekly = calculateWeeklyProgress(fourPerWeek, THU, completions, config);

    const evaluation = buildGoalEvaluation({
      goal: weeklyGoal,
      date: THU,
      occurrence: getOccurrenceForDate(fourPerWeek, THU, config),
      status: "pending",
      facts: facts(),
      weekFacts: facts({ workoutCount: 3 }),
      weekly,
      settings: config,
    });

    expect(evaluation.summary).toContain("3 of 4");
    expect(evaluation.summary).toContain("75%");
    expect(evaluation.summary).toContain("1 to go");
    expect(evaluation.summary).not.toContain("of 7");
  });

  it("measures against the whole week's facts, not just today's", () => {
    const measurement = measureGoal(weeklyGoal, facts({ workoutCount: 3 }));
    expect(measurement.value).toBe(3);
    expect(evaluateGoal(weeklyGoal, measurement).met).toBe(false);
    expect(evaluateGoal(weeklyGoal, measureGoal(weeklyGoal, facts({ workoutCount: 4 }))).met).toBe(true);
  });

  it("is not failed before the week ends", () => {
    const weekly = calculateWeeklyProgress(fourPerWeek, THU, [], config);
    expect(weekly.failed).toBe(false);
  });
});

describe("target descriptions", () => {
  it("renders each comparison readably", () => {
    expect(describeGoalTarget(goal({ direction: "gte", target: 160, unit: "g" }))).toBe("≥ 160 g");
    expect(describeGoalTarget(goal({ direction: "lte", target: 2200, unit: "kcal" }))).toBe("≤ 2200 kcal");
    expect(describeGoalTarget(goal({ direction: "range", target: 2000, targetMax: 2300, unit: "kcal" }))).toBe(
      "2000–2300 kcal",
    );
    expect(describeGoalTarget(goal({ direction: "boolean" }))).toBe("Complete");
  });
});

describe("disabled and archived goals", () => {
  it("a disabled goal stops applying but its history is untouched", () => {
    const disabled = item({ enabled: false });
    expect(getOccurrenceForDate(disabled, MON, settings()).state).toBe("disabled");
    // Past completions still resolve as completions.
    const resolved = getStatusForDate(disabled, MON, { date: MON, status: "done" }, settings());
    expect(resolved.status).toBe("completed");
  });
});
