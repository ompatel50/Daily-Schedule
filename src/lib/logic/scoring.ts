import { clamp } from "@/lib/utils";

/**
 * The single "how did today go?" number, 0–100, used by the calendar heatmap,
 * the dashboard ring and the weekly review.
 *
 * Weighting rationale: the app is a *planner first*, so finishing what you
 * planned and holding your habits matter most. Nutrition and training are
 * scored as "did you log and hit roughly the right range", because logging
 * itself is the behaviour worth reinforcing.
 */
export interface DayInputs {
  plannedCount: number;
  completedCount: number;
  habitsDue: number;
  habitsDone: number;
  calories: number;
  calorieGoal: number;
  workoutMinutes: number;
  /** Weekly workout target expressed as an average daily minute goal. */
  workoutMinuteGoal: number;
  /** True when the day has any food logged at all. */
  loggedNutrition: boolean;
}

export const SCORE_WEIGHTS = {
  planner: 0.35,
  habits: 0.35,
  nutrition: 0.15,
  training: 0.15,
} as const;

export function scoreDay(input: DayInputs): number {
  const parts: Array<{ weight: number; value: number }> = [];

  if (input.plannedCount > 0) {
    parts.push({
      weight: SCORE_WEIGHTS.planner,
      value: input.completedCount / input.plannedCount,
    });
  }

  if (input.habitsDue > 0) {
    parts.push({ weight: SCORE_WEIGHTS.habits, value: input.habitsDone / input.habitsDue });
  }

  if (input.loggedNutrition && input.calorieGoal > 0) {
    parts.push({ weight: SCORE_WEIGHTS.nutrition, value: calorieAccuracy(input.calories, input.calorieGoal) });
  }

  if (input.workoutMinuteGoal > 0) {
    parts.push({
      weight: SCORE_WEIGHTS.training,
      value: clamp(input.workoutMinutes / input.workoutMinuteGoal, 0, 1),
    });
  }

  if (parts.length === 0) return 0;

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const weighted = parts.reduce((sum, part) => sum + part.weight * clamp(part.value, 0, 1), 0);
  return Math.round((weighted / totalWeight) * 100);
}

/**
 * 1.0 when within 10% of the goal, tapering to 0 at ±50%. Both over- and
 * under-eating reduce the score, which is what makes it useful as a signal.
 */
export function calorieAccuracy(actual: number, goal: number): number {
  if (goal <= 0 || actual <= 0) return 0;
  const deviation = Math.abs(actual - goal) / goal;
  if (deviation <= 0.1) return 1;
  if (deviation >= 0.5) return 0;
  return 1 - (deviation - 0.1) / 0.4;
}

/** Heatmap bucket for a 0–100 score. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(score: number, hasData: boolean): HeatLevel {
  if (!hasData || score <= 0) return 0;
  if (score < 40) return 1;
  if (score < 65) return 2;
  if (score < 85) return 3;
  return 4;
}

export const HEAT_CLASSES: Record<HeatLevel, string> = {
  0: "bg-muted/60",
  1: "bg-emerald-500/20",
  2: "bg-emerald-500/40",
  3: "bg-emerald-500/65",
  4: "bg-emerald-500/90",
};

/** Compare two windows and return a signed percentage-point delta. */
export function trendDelta(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

/** Simple moving average, used to smooth noisy health series. */
export function movingAverage(values: Array<number | null>, window = 7): Array<number | null> {
  return values.map((_, index) => {
    const slice = values
      .slice(Math.max(0, index - window + 1), index + 1)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** Least-squares slope per day; positive = improving over time. */
export function linearTrend(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}
