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
import { prisma } from "@/lib/db";
import { type DayKey, dayRange, daysBetween, shiftDay, weekRange } from "@/lib/date";
import { aggregateDayAll } from "@/lib/logic/health";
import { round, sum } from "@/lib/utils";
import { getDayScore, scoreOptionsFor } from "@/server/day-score";
import { getHabitDayTotals } from "@/server/habits";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * `CalendarDaySummary` is a cache, not a source of truth. Anything that writes
 * planner/habit/nutrition/workout/health data calls `recomputeDay` afterwards,
 * so the heatmap and insights can read one small table instead of joining five.
 *
 * It is always safe to recompute — `rebuildSummaries` regenerates the whole
 * range from scratch (used after import/restore).
 */

export async function recomputeDay(userId: string, date: DayKey): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      weekStartsOn: true,
      timezone: true,
      scoreWeights: true,
      scoreOptionalTasks: true,
    },
  });
  const settings = scheduleSettingsFor(user ?? { weekStartsOn: 1, timezone: "UTC" });

  const [items, habitTotals, meals, workouts, metrics, dayScore] = await Promise.all([
    prisma.scheduleItem.findMany({ where: { userId, date }, select: { status: true } }),
    // Habit due-ness comes from the shared schedule engine, so a weekday habit
    // contributes nothing on a Saturday rather than counting as unmet.
    getHabitDayTotals(userId, date, settings),
    prisma.meal.findMany({ where: { userId, date }, select: { entries: true } }),
    prisma.workout.findMany({
      where: { userId, date, status: "completed" },
      select: { durationMin: true, caloriesBurned: true },
    }),
    prisma.healthMetric.findMany({
      where: { userId, date },
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
    // The score comes from the one central service — the same call the
    // Dashboard, Today, the calendar detail and Insights all make. This table
    // caches its answer; it does not compute a second one.
    getDayScore(
      userId,
      date,
      settings,
      scoreOptionsFor(user ?? { scoreWeights: null, scoreOptionalTasks: false }),
    ),
  ]);

  const plannedCount = items.length;
  const completedCount = items.filter((item) => item.status === "done").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;

  // Excused days leave the denominator entirely; a deliberate skip stays in it,
  // because the occurrence really was scheduled and really was not done.
  const habitsDue = habitTotals.due;
  const habitsDone = habitTotals.done;

  const entries = meals.flatMap((meal) => meal.entries);
  const calories = round(sum(entries, (entry) => entry.calories), 0);
  const protein = round(sum(entries, (entry) => entry.protein), 1);
  const carbs = round(sum(entries, (entry) => entry.carbs), 1);
  const fat = round(sum(entries, (entry) => entry.fat), 1);

  const workoutMinutes = sum(workouts, (workout) => workout.durationMin);
  const caloriesBurned = sum(workouts, (workout) => workout.caloriesBurned ?? 0);

  // A day can carry many rows per metric (samples, several devices); the one
  // aggregation module decides what the day's number is.
  const aggregated = aggregateDayAll(metrics);
  const metricValue = (type: string) => aggregated.get(type)?.value ?? null;

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
    score: dayScore.score ?? 0,
    scoreApplicable: dayScore.totals.applicable,
    scoreCompleted: dayScore.totals.completed,
    scoreMissed: dayScore.totals.missed,
    scorePending: dayScore.totals.pending,
    scoreExcluded: dayScore.totals.excluded,
  };

  await prisma.calendarDaySummary.upsert({
    where: { userId_date: { userId, date } },
    create: { userId, date, ...data },
    update: data,
  });
}

/** How many days recompute concurrently during a rebuild. */
const REBUILD_CONCURRENCY = 8;

async function recomputeDays(userId: string, days: DayKey[]): Promise<number> {
  // Bounded concurrency: each day's recompute is ~10 independent reads plus
  // one upsert, so running a small batch in parallel multiplies throughput on
  // Postgres without unbounded connection or memory pressure. Results are
  // identical to the sequential walk — recomputeDay(d) only ever writes d.
  for (let index = 0; index < days.length; index += REBUILD_CONCURRENCY) {
    await Promise.all(
      days.slice(index, index + REBUILD_CONCURRENCY).map((day) => recomputeDay(userId, day)),
    );
  }
  return days.length;
}

/** Recompute a contiguous range — used by seeding, import and restore. */
export async function rebuildSummaries(userId: string, from: DayKey, to: DayKey): Promise<number> {
  return recomputeDays(userId, dayRange(from, to));
}

/**
 * Recompute exactly the days an import (or removal) touched, instead of the
 * whole span between its first and last date. Each touched day is expanded
 * by ±6 days: a day's score can depend on the rest of its week (weekly
 * goals), and the widened window covers the containing week under either
 * week-start convention — so the result is identical to a full-range
 * rebuild, without walking years of untouched days in between.
 */
export async function rebuildSummariesForDates(
  userId: string,
  dates: Iterable<DayKey>,
): Promise<number> {
  const expanded = new Set<DayKey>();
  for (const date of dates) {
    for (let offset = -6; offset <= 6; offset += 1) {
      expanded.add(shiftDay(date, offset));
    }
  }
  return recomputeDays(userId, [...expanded].sort());
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
  // A day with nothing applicable has no score at all. Averaging it in as 0
  // would punish a rest day for being restful.
  const withData = summaries.filter((summary) => summary.scoreApplicable > 0);

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

/** Whether this day's score is a real number rather than "nothing applied". */
export function summaryHasScore(summary: { scoreApplicable: number }): boolean {
  return summary.scoreApplicable > 0;
}

export function daysInWindow(from: DayKey, to: DayKey): number {
  return Math.max(0, daysBetween(from, to) + 1);
}
