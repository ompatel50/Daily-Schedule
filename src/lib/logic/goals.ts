import type { DayKey } from "@/lib/date";
import type {
  DayStatus,
  Occurrence,
  ScheduleSettings,
  WeeklyProgress,
} from "@/lib/logic/schedule";

/**
 * Goal evaluation.
 *
 * A goal answers "am I doing the thing I said I would?" — and the app should
 * answer it from data it already has wherever it can, rather than asking the
 * user to tick a box it can already prove. `GoalSource` is that link: it names
 * the record type that settles the goal.
 *
 * Pure: the server measures the facts, this module decides what they mean.
 */

export const GOAL_SOURCES = [
  "manual",
  "workout_count",
  "workout_minutes",
  "workout_distance",
  "steps",
  "active_calories",
  "sleep_hours",
  "hydration",
  "calories",
  "protein",
  "carbs",
  "fat",
  "fiber",
  "habit",
  "planner_required",
] as const;
export type GoalSource = (typeof GOAL_SOURCES)[number];

export const GOAL_SOURCE_META: Record<GoalSource, { label: string; unit: string; description: string }> = {
  manual: { label: "Manual", unit: "", description: "You mark it done yourself" },
  workout_count: { label: "Completed workouts", unit: "", description: "Counted from completed workouts" },
  workout_minutes: { label: "Workout minutes", unit: "min", description: "Summed from completed workout durations" },
  workout_distance: { label: "Workout distance", unit: "km", description: "Summed from completed workout distances" },
  steps: { label: "Steps", unit: "", description: "From the steps health metric" },
  active_calories: { label: "Active calories", unit: "kcal", description: "From the active-calories health metric" },
  sleep_hours: { label: "Sleep", unit: "h", description: "From the sleep health metric" },
  hydration: { label: "Hydration", unit: "ml", description: "From the hydration health metric" },
  calories: { label: "Calories eaten", unit: "kcal", description: "Summed from logged meals" },
  protein: { label: "Protein", unit: "g", description: "Summed from logged meals" },
  carbs: { label: "Carbohydrates", unit: "g", description: "Summed from logged meals" },
  fat: { label: "Fat", unit: "g", description: "Summed from logged meals" },
  fiber: { label: "Fiber", unit: "g", description: "Summed from logged meals" },
  habit: { label: "Linked habit", unit: "", description: "Completed when the linked habit is done" },
  planner_required: { label: "Required planner items", unit: "", description: "From required schedule items completed" },
};

export const GOAL_COMPARISONS = ["gte", "lte", "eq", "range", "boolean"] as const;
export type GoalComparison = (typeof GOAL_COMPARISONS)[number];

export const GOAL_COMPARISON_META: Record<GoalComparison, { label: string; short: string }> = {
  gte: { label: "At least", short: "≥" },
  lte: { label: "At most", short: "≤" },
  eq: { label: "Exactly", short: "=" },
  range: { label: "Within a range", short: "–" },
  boolean: { label: "Completed / not completed", short: "✓" },
};

export type GoalPeriod = "daily" | "weekly" | "monthly";

export interface GoalLike {
  id: string;
  label: string;
  description?: string | null;
  domain: string;
  metric: string;
  target: number;
  targetMax: number | null;
  unit: string;
  /** One of GOAL_COMPARISONS; stored in `Goal.direction` for compatibility. */
  direction: string;
  period: string;
  source: string;
  sourceRef: string | null;
}

/**
 * The facts for one period, measured by the server from records that already
 * exist. `null` means "not logged", which is deliberately different from `0`.
 */
export interface GoalFacts {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  steps: number | null;
  activeCalories: number | null;
  sleepHours: number | null;
  hydrationMl: number | null;
  workoutCount: number;
  workoutMinutes: number;
  workoutDistanceKm: number;
  /** Habit ids completed in the period. */
  habitsDone: Set<string>;
  plannerRequired: number;
  plannerRequiredDone: number;
  /** Manual goal entries, keyed by goal id. */
  manual: Map<string, { status: string; value: number | null }>;
}

export function emptyFacts(): GoalFacts {
  return {
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    fiber: null,
    steps: null,
    activeCalories: null,
    sleepHours: null,
    hydrationMl: null,
    workoutCount: 0,
    workoutMinutes: 0,
    workoutDistanceKm: 0,
    habitsDone: new Set(),
    plannerRequired: 0,
    plannerRequiredDone: 0,
    manual: new Map(),
  };
}

export interface Measurement {
  value: number | null;
  /** False when the underlying record simply was not logged. */
  hasData: boolean;
}

/**
 * Read the goal's number out of the measured facts.
 *
 * The `hasData` flag matters as much as the value: "you ate 0 g of protein" and
 * "you did not log any food" are different statements, and only the first is a
 * failure.
 */
export function measureGoal(goal: GoalLike, facts: GoalFacts): Measurement {
  const fromMetric = (value: number | null): Measurement => ({
    value,
    hasData: value !== null,
  });

  switch (goal.source as GoalSource) {
    case "calories":
      return fromMetric(facts.calories);
    case "protein":
      return fromMetric(facts.protein);
    case "carbs":
      return fromMetric(facts.carbs);
    case "fat":
      return fromMetric(facts.fat);
    case "fiber":
      return fromMetric(facts.fiber);
    case "steps":
      return fromMetric(facts.steps);
    case "active_calories":
      return fromMetric(facts.activeCalories);
    case "sleep_hours":
      return fromMetric(facts.sleepHours);
    case "hydration":
      return fromMetric(facts.hydrationMl);

    // Counted records: an absence really is a zero, because a workout that
    // happened would have a row.
    case "workout_count":
      return { value: facts.workoutCount, hasData: true };
    case "workout_minutes":
      return { value: facts.workoutMinutes, hasData: true };
    case "workout_distance":
      return { value: facts.workoutDistanceKm, hasData: true };

    case "habit":
      return {
        value: goal.sourceRef && facts.habitsDone.has(goal.sourceRef) ? 1 : 0,
        hasData: true,
      };

    case "planner_required":
      return {
        value: facts.plannerRequiredDone,
        hasData: facts.plannerRequired > 0,
      };

    case "manual":
    default: {
      const entry = facts.manual.get(goal.id);
      if (!entry) return { value: null, hasData: false };
      if (entry.value !== null && entry.value !== undefined) {
        return { value: entry.value, hasData: true };
      }
      return { value: entry.status === "done" ? 1 : 0, hasData: true };
    }
  }
}

export interface GoalOutcome {
  met: boolean;
  /** 0–1, capped. Null when there is no data to judge. */
  progress: number | null;
  hasData: boolean;
}

/**
 * Compare a measured value with the goal's target.
 *
 * Partial credit is given only where a partial amount is genuinely partial
 * progress — 120 g of a 160 g protein target is three-quarters of the way
 * there. A binary goal ("did one workout", "completed the habit") stays binary.
 */
export function evaluateGoal(goal: GoalLike, measurement: Measurement): GoalOutcome {
  if (!measurement.hasData || measurement.value === null) {
    return { met: false, progress: null, hasData: false };
  }

  const value = measurement.value;
  const target = goal.target;
  const comparison = goal.direction as GoalComparison;

  switch (comparison) {
    case "boolean":
      return { met: value >= 1, progress: value >= 1 ? 1 : 0, hasData: true };

    case "lte": {
      // Staying under a ceiling is all-or-nothing at the boundary, then tapers
      // so a small overshoot is not scored the same as double.
      const met = value <= target;
      const overshoot = target <= 0 ? 1 : (value - target) / target;
      return {
        met,
        progress: met ? 1 : Math.max(0, 1 - overshoot),
        hasData: true,
      };
    }

    case "eq": {
      const met = Math.abs(value - target) < 1e-9;
      const deviation = target <= 0 ? 1 : Math.abs(value - target) / target;
      return { met, progress: met ? 1 : Math.max(0, 1 - deviation), hasData: true };
    }

    case "range": {
      const upper = goal.targetMax ?? target;
      const lower = Math.min(target, upper);
      const high = Math.max(target, upper);
      if (value >= lower && value <= high) return { met: true, progress: 1, hasData: true };
      const distance = value < lower ? lower - value : value - high;
      const span = high - lower || high || 1;
      return { met: false, progress: Math.max(0, 1 - distance / span), hasData: true };
    }

    case "gte":
    default: {
      if (target <= 0) return { met: value > 0, progress: value > 0 ? 1 : 0, hasData: true };
      return {
        met: value >= target,
        progress: Math.min(1, Math.max(0, value / target)),
        hasData: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Full evaluation
// ---------------------------------------------------------------------------

export interface GoalEvaluation {
  goal: GoalLike;
  date: DayKey;
  occurrence: Occurrence;
  /** The resolved day status — rest, not scheduled, pending, missed… */
  status: DayStatus;
  /** Whether this goal places any requirement on this date at all. */
  applicable: boolean;
  measurement: Measurement;
  outcome: GoalOutcome;
  /** Set for weekly goals and times-per-week schedules. */
  weekly: WeeklyProgress | null;
  /** One line the UI can show verbatim. */
  summary: string;
}

function formatValue(value: number, unit: string): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

/**
 * The sentence shown under a goal. Deliberately factual: it states what was
 * measured against what was asked for, and never editorialises.
 */
export function describeGoalProgress(
  goal: GoalLike,
  measurement: Measurement,
  outcome: GoalOutcome,
  status: DayStatus,
  weekly: WeeklyProgress | null,
): string {
  if (status === "rest") return "Rest day — not scheduled";
  if (status === "not_scheduled") return "Not scheduled today";
  if (status === "canceled") return "Cancelled for this date";
  if (status === "excused") return "Excused — streak protected";
  if (status === "inactive") return "Inactive";
  if (status === "future") return "Scheduled — upcoming";

  if (weekly) {
    return `${weekly.done} of ${weekly.target} this week · ${weekly.percent}%${
      weekly.remaining > 0 ? ` · ${weekly.remaining} to go` : ""
    }`;
  }

  if (!measurement.hasData || measurement.value === null) return "Not logged yet";

  const comparison = goal.direction as GoalComparison;
  if (comparison === "boolean") return outcome.met ? "Completed" : "Not completed yet";

  const actual = formatValue(measurement.value, goal.unit);
  if (comparison === "range") {
    const upper = goal.targetMax ?? goal.target;
    return `${actual} · target ${formatValue(goal.target, "")}–${formatValue(upper, goal.unit)}`;
  }
  const operator = GOAL_COMPARISON_META[comparison]?.short ?? "≥";
  return `${actual} · target ${operator} ${formatValue(goal.target, goal.unit)}`;
}

/** Human-readable target, e.g. "≥ 160 g" or "2,000–2,300 kcal". */
export function describeGoalTarget(goal: GoalLike): string {
  const comparison = goal.direction as GoalComparison;
  if (comparison === "boolean") return "Complete";
  if (comparison === "range") {
    const upper = goal.targetMax ?? goal.target;
    return `${goal.target}–${upper}${goal.unit ? ` ${goal.unit}` : ""}`;
  }
  const operator = GOAL_COMPARISON_META[comparison]?.short ?? "≥";
  return `${operator} ${goal.target}${goal.unit ? ` ${goal.unit}` : ""}`;
}

/**
 * Does this goal get judged over the whole week rather than day by day?
 *
 * Two independent things can make a goal weekly: an explicit `period` of
 * "weekly", or a times-per-week schedule. Both must produce "3 of 4", never
 * "3 of 7", which is why this is one function and not a check repeated at
 * every call site.
 */
export function isWeeklyGoal(goal: GoalLike, occurrence: Occurrence): boolean {
  return goal.period === "weekly" || occurrence.rule?.mode === "times_per_week";
}

export function buildGoalEvaluation(params: {
  goal: GoalLike;
  date: DayKey;
  occurrence: Occurrence;
  status: DayStatus;
  facts: GoalFacts;
  weekFacts: GoalFacts;
  weekly: WeeklyProgress | null;
  settings: ScheduleSettings;
}): GoalEvaluation {
  const { goal, date, occurrence, status } = params;
  const weekly = isWeeklyGoal(goal, occurrence) ? params.weekly : null;

  const measurement = measureGoal(goal, weekly ? params.weekFacts : params.facts);
  const outcome = evaluateGoal(goal, measurement);

  const applicable = occurrence.active || occurrence.flexible || Boolean(weekly);

  return {
    goal,
    date,
    occurrence,
    status,
    applicable,
    measurement,
    outcome,
    weekly,
    summary: describeGoalProgress(goal, measurement, outcome, status, weekly),
  };
}
