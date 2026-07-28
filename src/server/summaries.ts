import "server-only";

import { prisma } from "@/lib/db";
import { type DayKey, dayRange, daysBetween, weekRange } from "@/lib/date";
import { isHabitDue } from "@/lib/logic/recurrence";
import { scoreDay } from "@/lib/logic/scoring";
import { parseJson, round, sum } from "@/lib/utils";

/**
 * `CalendarDaySummary` is a cache, not a source of truth. Anything that writes
 * planner/habit/nutrition/workout/health data calls `recomputeDay` afterwards,
 * so the heatmap and insights can read one small table instead of joining five.
 *
 * It is always safe to recompute — `rebuildSummaries` regenerates the whole
 * range from scratch (used after import/restore).
 */

export async function recomputeDay(userId: string, date: DayKey): Promise<void> {
  const [items, habits, habitLogs, meals, workouts, metrics, goals] = await Promise.all([
    prisma.scheduleItem.findMany({ where: { userId, date }, select: { status: true } }),
    prisma.habit.findMany({
      where: { userId, archived: false },
      select: { id: true, frequency: true, weekdays: true, startDate: true, endDate: true },
    }),
    prisma.habitLog.findMany({ where: { userId, date }, select: { habitId: true, status: true } }),
    prisma.meal.findMany({ where: { userId, date }, select: { entries: true } }),
    prisma.workout.findMany({
      where: { userId, date, status: "completed" },
      select: { durationMin: true, caloriesBurned: true },
    }),
    prisma.healthMetric.findMany({ where: { userId, date }, select: { type: true, value: true } }),
    prisma.goal.findMany({ where: { userId, active: true } }),
  ]);

  const plannedCount = items.length;
  const completedCount = items.filter((item) => item.status === "done").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;

  const doneHabitIds = new Set(
    habitLogs.filter((log) => log.status === "done").map((log) => log.habitId),
  );
  const skippedHabitIds = new Set(
    habitLogs.filter((log) => log.status === "skipped").map((log) => log.habitId),
  );
  const dueHabits = habits.filter((habit) =>
    isHabitDue(
      {
        frequency: habit.frequency,
        weekdays: parseJson<number[]>(habit.weekdays, []),
        startDate: habit.startDate,
        endDate: habit.endDate,
      },
      date,
    ),
  );
  // Deliberate skips shouldn't count against the day.
  const habitsDue = dueHabits.filter((habit) => !skippedHabitIds.has(habit.id)).length;
  const habitsDone = dueHabits.filter((habit) => doneHabitIds.has(habit.id)).length;

  const entries = meals.flatMap((meal) => meal.entries);
  const calories = round(sum(entries, (entry) => entry.calories), 0);
  const protein = round(sum(entries, (entry) => entry.protein), 1);
  const carbs = round(sum(entries, (entry) => entry.carbs), 1);
  const fat = round(sum(entries, (entry) => entry.fat), 1);

  const workoutMinutes = sum(workouts, (workout) => workout.durationMin);
  const caloriesBurned = sum(workouts, (workout) => workout.caloriesBurned ?? 0);

  const metricValue = (type: string) => metrics.find((metric) => metric.type === type)?.value ?? null;

  const calorieGoal = goals.find((goal) => goal.metric === "calories")?.target ?? 0;
  const weeklyWorkoutGoal = goals.find((goal) => goal.metric === "workouts_per_week")?.target ?? 0;
  const workoutMinuteGoal = weeklyWorkoutGoal > 0 ? (weeklyWorkoutGoal * 45) / 7 : 0;

  const score = scoreDay({
    plannedCount,
    completedCount,
    habitsDue,
    habitsDone,
    calories,
    calorieGoal,
    workoutMinutes,
    workoutMinuteGoal,
    loggedNutrition: entries.length > 0,
  });

  const data = {
    plannedCount,
    completedCount,
    skippedCount,
    habitsDue,
    habitsDone,
    calories,
    protein,
    carbs,
    fat,
    workoutCount: workouts.length,
    workoutMinutes,
    caloriesBurned,
    steps: metricValue("steps"),
    sleepHours: metricValue("sleep_hours"),
    bodyWeight: metricValue("body_weight"),
    score,
  };

  await prisma.calendarDaySummary.upsert({
    where: { userId_date: { userId, date } },
    create: { userId, date, ...data },
    update: data,
  });
}

/** Recompute a contiguous range — used by seeding, import and restore. */
export async function rebuildSummaries(userId: string, from: DayKey, to: DayKey): Promise<number> {
  const days = dayRange(from, to);
  for (const day of days) {
    // Sequential on purpose: SQLite serialises writes anyway, and this keeps
    // memory flat when rebuilding a year of history.
    await recomputeDay(userId, day);
  }
  return days.length;
}

export async function getSummaries(userId: string, from: DayKey, to: DayKey) {
  return prisma.calendarDaySummary.findMany({
    where: { userId, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
  });
}

export async function getWeekSummary(userId: string, day: DayKey, weekStartsOn: 0 | 1 = 1) {
  const { start, end } = weekRange(day, weekStartsOn);
  const summaries = await getSummaries(userId, start, end);
  const withData = summaries.filter((summary) => summary.score > 0);

  return {
    start,
    end,
    days: summaries,
    planned: sum(summaries, (s) => s.plannedCount),
    completed: sum(summaries, (s) => s.completedCount),
    habitsDue: sum(summaries, (s) => s.habitsDue),
    habitsDone: sum(summaries, (s) => s.habitsDone),
    calories: sum(summaries, (s) => s.calories),
    workouts: sum(summaries, (s) => s.workoutCount),
    workoutMinutes: sum(summaries, (s) => s.workoutMinutes),
    activeDays: withData.length,
    averageScore:
      withData.length === 0 ? 0 : Math.round(sum(withData, (s) => s.score) / withData.length),
  };
}

/**
 * Days that have *any* record at all — used to decide whether a gap in the
 * calendar means "missed" or "before you started using the app".
 */
export async function getTrackedRange(userId: string): Promise<{ first: DayKey; last: DayKey } | null> {
  const [first, last] = await Promise.all([
    prisma.calendarDaySummary.findFirst({ where: { userId }, orderBy: { date: "asc" } }),
    prisma.calendarDaySummary.findFirst({ where: { userId }, orderBy: { date: "desc" } }),
  ]);
  if (!first || !last) return null;
  return { first: first.date, last: last.date };
}

export function summaryHasData(summary: {
  plannedCount: number;
  habitsDue: number;
  calories: number;
  workoutCount: number;
}): boolean {
  return (
    summary.plannedCount > 0 ||
    summary.habitsDue > 0 ||
    summary.calories > 0 ||
    summary.workoutCount > 0
  );
}

export function daysInWindow(from: DayKey, to: DayKey): number {
  return Math.max(0, daysBetween(from, to) + 1);
}
