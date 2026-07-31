/**
 * NOTE ON `server-only`: this module is part of the shared computation layer
 * (facts → schedule → goals → score → summaries) rather than the app-facing
 * server surface. The guard lives on `src/server/queries.ts` and the modules in
 * `src/server/actions/`, which are what pages and components import directly.
 * Keeping it off the computation modules is deliberate: it lets the seed script
 * and future CLI tooling call the *real* aggregation instead of maintaining a
 * hand-copied duplicate of the formula, which is precisely the drift this
 * upgrade set out to remove.
 */
import { prisma } from "@/lib/prisma";
import { type DayKey, dayRange, daysBetween } from "@/lib/date";
import { emptyFacts, type GoalFacts } from "@/lib/logic/goals";
import { aggregateDayAll } from "@/lib/logic/health";

/**
 * Measures what actually happened, per day, from the records the app already
 * has. Everything that judges a day — goals, the day score, insights — reads
 * these facts rather than running its own queries, so they cannot disagree
 * about what a day contained.
 *
 * One batched read per domain across the whole range: the calendar asks for a
 * month at a time and must not turn that into 30 round trips.
 *
 * Health metrics are combined by the one aggregation module in
 * `src/lib/logic/health.ts` — sum-per-device-then-best-device for cumulative
 * metrics, latest for weight, stage-aware for sleep — so goals, the Health
 * page and the trends cannot disagree about what a day's number is.
 */

export interface FactsOptions {
  /** Whether low-priority planner items count as required. */
  scoreOptionalTasks?: boolean;
}

/**
 * Per-day facts for every day in [from, to]. Days with no records still get an
 * entry, with `null` for anything that was never logged — the difference
 * between "ate nothing" and "logged nothing" has to survive this far.
 */
export async function measureFactsByDay(
  userId: string,
  from: DayKey,
  to: DayKey,
  options: FactsOptions = {},
): Promise<Map<DayKey, GoalFacts>> {
  const byDay = new Map<DayKey, GoalFacts>();
  if (daysBetween(from, to) < 0) return byDay;
  for (const date of dayRange(from, to)) byDay.set(date, emptyFacts());

  const range = { gte: from, lte: to };

  const [meals, metrics, workouts, habitLogs, plannerItems, goalEntries] = await Promise.all([
    prisma.meal.findMany({
      where: { userId, date: range },
      select: {
        date: true,
        entries: {
          select: { calories: true, protein: true, carbs: true, fat: true, fiber: true },
        },
      },
    }),
    prisma.healthMetric.findMany({
      where: { userId, date: range },
      select: {
        date: true,
        type: true,
        subtype: true,
        value: true,
        unit: true,
        source: true,
        sourceApp: true,
        recordedAt: true,
        startAt: true,
        endAt: true,
        createdAt: true,
      },
    }),
    prisma.workout.findMany({
      where: { userId, date: range, status: "completed" },
      select: { date: true, durationMin: true, distanceKm: true },
    }),
    prisma.habitLog.findMany({
      where: { userId, date: range, status: "done" },
      select: { date: true, habitId: true },
    }),
    prisma.scheduleItem.findMany({
      where: { userId, date: range },
      select: { date: true, status: true, priority: true },
    }),
    prisma.goalEntry.findMany({
      where: { userId, date: range },
      select: { date: true, goalId: true, status: true, value: true },
    }),
  ]);

  // --- nutrition ------------------------------------------------------------
  for (const meal of meals) {
    const facts = byDay.get(meal.date);
    if (!facts || meal.entries.length === 0) continue;
    facts.calories = (facts.calories ?? 0) + sumBy(meal.entries, (entry) => entry.calories);
    facts.protein = (facts.protein ?? 0) + sumBy(meal.entries, (entry) => entry.protein);
    facts.carbs = (facts.carbs ?? 0) + sumBy(meal.entries, (entry) => entry.carbs);
    facts.fat = (facts.fat ?? 0) + sumBy(meal.entries, (entry) => entry.fat);
    facts.fiber = (facts.fiber ?? 0) + sumBy(meal.entries, (entry) => entry.fiber);
  }

  // --- health metrics -------------------------------------------------------
  const metricsByDay = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    const group = metricsByDay.get(metric.date);
    if (group) group.push(metric);
    else metricsByDay.set(metric.date, [metric]);
  }

  for (const [date, rows] of metricsByDay) {
    const facts = byDay.get(date);
    if (!facts) continue;
    const aggregated = aggregateDayAll(rows);
    facts.steps = aggregated.get("steps")?.value ?? facts.steps;
    facts.activeCalories = aggregated.get("active_calories")?.value ?? facts.activeCalories;
    facts.sleepHours = aggregated.get("sleep_hours")?.value ?? facts.sleepHours;
    facts.hydrationMl = aggregated.get("hydration_ml")?.value ?? facts.hydrationMl;
  }

  // --- workouts -------------------------------------------------------------
  for (const workout of workouts) {
    const facts = byDay.get(workout.date);
    if (!facts) continue;
    facts.workoutCount += 1;
    facts.workoutMinutes += workout.durationMin;
    facts.workoutDistanceKm += workout.distanceKm ?? 0;
  }

  // --- habits ---------------------------------------------------------------
  for (const log of habitLogs) {
    byDay.get(log.date)?.habitsDone.add(log.habitId);
  }

  // --- planner --------------------------------------------------------------
  for (const item of plannerItems) {
    const facts = byDay.get(item.date);
    if (!facts) continue;
    // "Required" means anything the user did not explicitly mark low priority.
    // Optional work only enters the denominator if the user asked for it to.
    const required = options.scoreOptionalTasks || item.priority !== "low";
    if (!required) continue;
    if (item.status === "skipped") continue; // deliberately dropped, not owed
    facts.plannerRequired += 1;
    if (item.status === "done") facts.plannerRequiredDone += 1;
  }

  // --- manual goal entries --------------------------------------------------
  for (const entry of goalEntries) {
    byDay.get(entry.date)?.manual.set(entry.goalId, { status: entry.status, value: entry.value });
  }

  return byDay;
}

function sumBy<T>(rows: T[], get: (row: T) => number): number {
  return rows.reduce((total, row) => total + get(row), 0);
}

/**
 * Roll a set of daily facts into one period total.
 *
 * Only additive quantities are added. A weekly protein total is the sum of its
 * days; a weekly body weight is not, which is why nothing here touches
 * point-in-time metrics.
 */
export function sumFacts(days: GoalFacts[]): GoalFacts {
  const total = emptyFacts();
  let sawNutrition = false;
  let sawSteps = false;
  let sawActive = false;
  let sawSleep = false;
  let sawHydration = false;

  for (const day of days) {
    if (day.calories !== null) {
      sawNutrition = true;
      total.calories = (total.calories ?? 0) + day.calories;
      total.protein = (total.protein ?? 0) + (day.protein ?? 0);
      total.carbs = (total.carbs ?? 0) + (day.carbs ?? 0);
      total.fat = (total.fat ?? 0) + (day.fat ?? 0);
      total.fiber = (total.fiber ?? 0) + (day.fiber ?? 0);
    }
    if (day.steps !== null) {
      sawSteps = true;
      total.steps = (total.steps ?? 0) + day.steps;
    }
    if (day.activeCalories !== null) {
      sawActive = true;
      total.activeCalories = (total.activeCalories ?? 0) + day.activeCalories;
    }
    if (day.sleepHours !== null) {
      sawSleep = true;
      total.sleepHours = (total.sleepHours ?? 0) + day.sleepHours;
    }
    if (day.hydrationMl !== null) {
      sawHydration = true;
      total.hydrationMl = (total.hydrationMl ?? 0) + day.hydrationMl;
    }

    total.workoutCount += day.workoutCount;
    total.workoutMinutes += day.workoutMinutes;
    total.workoutDistanceKm += day.workoutDistanceKm;
    total.plannerRequired += day.plannerRequired;
    total.plannerRequiredDone += day.plannerRequiredDone;
    for (const habitId of day.habitsDone) total.habitsDone.add(habitId);
    for (const [goalId, entry] of day.manual) {
      const existing = total.manual.get(goalId);
      if (!existing || entry.status === "done") total.manual.set(goalId, entry);
    }
  }

  if (!sawNutrition) {
    total.calories = null;
    total.protein = null;
    total.carbs = null;
    total.fat = null;
    total.fiber = null;
  }
  if (!sawSteps) total.steps = null;
  if (!sawActive) total.activeCalories = null;
  if (!sawSleep) total.sleepHours = null;
  if (!sawHydration) total.hydrationMl = null;

  return total;
}
