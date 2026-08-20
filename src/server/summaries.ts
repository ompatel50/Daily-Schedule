/**
 * NOTE ON `server-only`: this module is part of the shared computation layer
 * (facts → schedule → goals → score → summaries) rather than the app-facing
 * server surface. The guard lives on `src/server/queries.ts` and the modules in
 * `src/server/actions/`, which are what pages and components import directly.
 * Keeping it off the computation modules is deliberate: it lets the seed script
 * and future CLI tooling call the *real* aggregation instead of maintaining a
 * hand-copied duplicate of the formula, which is precisely the drift this
 * upgrade set out to remove.
 *
 * For the same reason this chain imports the client from `@/lib/prisma`
 * directly rather than from `@/lib/db`: the latter also re-exports
 * `getCurrentUser`, which pulls `server-only` in transitively and would break
 * the seed CLI the moment it loaded. Anything here that needs a *user* takes
 * a userId argument — resolving "who is asking" is the caller's job.
 */
import { prisma } from "@/lib/prisma";
import { type DayKey, dayRange, daysBetween, shiftDay, weekRange } from "@/lib/date";
import {
  dailyFactFromSummary,
  financeDayFacts,
  plannerMinuteFacts,
  workoutDayFacts,
} from "@/lib/logic/daily-facts";
import { aggregateDayAll } from "@/lib/logic/health";
import { centsOrLegacy } from "@/lib/logic/money";
import { operationalDayWhere, operationalDayWindow } from "@/lib/logic/operational-day";
import { resetMinuteOf } from "@/lib/logic/schedule";
import { round, sum } from "@/lib/utils";
import { getDayScore, scoreOptionsFor } from "@/server/day-score";
import { evaluateGoalsForDate } from "@/server/goals";
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
      dayResetMinute: true,
      scoreWeights: true,
      scoreOptionalTasks: true,
    },
  });
  const settings = scheduleSettingsFor(user ?? { weekStartsOn: 1, timezone: "UTC" });

  const scoreOptions = scoreOptionsFor(user ?? { scoreWeights: null, scoreOptionalTasks: false });
  // Tasks live on instants (createdAt/completedAt); the operational-day
  // window converts the day key to real bounds — never hand-subtracted hours.
  const dayWindow = operationalDayWindow(date, settings.timezone, resetMinuteOf(settings));

  const [
    items,
    habitTotals,
    meals,
    workouts,
    metrics,
    dayScore,
    goalEvaluations,
    transactions,
    journal,
    dayTypeOverride,
    tasksCreated,
    tasksCompleted,
    tasksDueOpen,
  ] = await Promise.all([
    // Planner records of the OPERATIONAL day — includes the after-midnight
    // tail on the next calendar date. Every other record type here stores its
    // operational day directly in `date`.
    prisma.scheduleItem.findMany({
      where: { userId, ...operationalDayWhere(date, resetMinuteOf(settings)) },
      select: {
        status: true,
        allDay: true,
        startMinute: true,
        endMinute: true,
        category: true,
      },
    }),
    // Habit due-ness comes from the shared schedule engine, so a weekday habit
    // contributes nothing on a Saturday rather than counting as unmet — and a
    // paused habit is excluded, never missed.
    getHabitDayTotals(userId, date, settings),
    prisma.meal.findMany({ where: { userId, date }, select: { entries: true } }),
    prisma.workout.findMany({
      where: { userId, date, status: "completed" },
      select: {
        durationMin: true,
        caloriesBurned: true,
        type: true,
        sets: { select: { reps: true, weightKg: true, completed: true } },
      },
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
    getDayScore(userId, date, settings, scoreOptions),
    // Same memoised evaluation the score itself uses (identical arguments →
    // request-level cache hit), read here for nutrition-target adherence.
    evaluateGoalsForDate(userId, date, settings, {
      scoreOptionalTasks: scoreOptions.scoreOptionalTasks ?? false,
    }),
    prisma.financeTransaction.findMany({
      where: { userId, date },
      select: { category: true, amountCents: true, amount: true },
    }),
    // findFirst, not findUnique: the soft-delete guard only filters the
    // former, and a trashed journal page must not read as "journaled".
    prisma.journalEntry.findFirst({
      where: { userId, date },
      select: { id: true },
    }),
    prisma.dayTypeOverride.findUnique({
      where: { userId_date: { userId, date } },
      select: { dayType: true },
    }),
    prisma.task.count({ where: { userId, createdAt: { gte: dayWindow.start, lt: dayWindow.end } } }),
    prisma.task.count({
      where: { userId, completedAt: { gte: dayWindow.start, lt: dayWindow.end } },
    }),
    prisma.task.count({ where: { userId, dueDate: date, status: "open" } }),
  ]);

  const plannedCount = items.length;
  const completedCount = items.filter((item) => item.status === "done").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const minutes = plannerMinuteFacts(items);

  const entries = meals.flatMap((meal) => meal.entries);
  const calories = round(sum(entries, (entry) => entry.calories), 0);
  const protein = round(sum(entries, (entry) => entry.protein), 1);
  const carbs = round(sum(entries, (entry) => entry.carbs), 1);
  const fat = round(sum(entries, (entry) => entry.fat), 1);
  const fiber = round(sum(entries, (entry) => entry.fiber), 1);

  // Nutrition-target adherence: the day's applicable, measured targets.
  const nutritionEvaluations = goalEvaluations.filter(
    (evaluation) =>
      (evaluation.goal.domain === "nutrition" || evaluation.goal.source === "hydration") &&
      evaluation.applicable &&
      evaluation.outcome.hasData,
  );
  const nutritionTargetsTotal = nutritionEvaluations.length;
  const nutritionTargetsMet = nutritionEvaluations.filter(
    (evaluation) => evaluation.outcome.met,
  ).length;

  const workoutMinutes = sum(workouts, (workout) => workout.durationMin);
  const caloriesBurned = sum(workouts, (workout) => workout.caloriesBurned ?? 0);
  const workoutFacts = workoutDayFacts(workouts);

  const override = dayTypeOverride?.dayType;
  const dayType =
    override === "training" || override === "rest"
      ? override
      : workouts.length > 0
        ? "training"
        : "rest";

  const finance = financeDayFacts(
    transactions.map((transaction) => ({
      category: transaction.category,
      amountCents: centsOrLegacy(transaction.amountCents, transaction.amount),
    })),
  );

  // A day can carry many rows per metric (samples, several devices); the one
  // aggregation module decides what the day's number is.
  const aggregated = aggregateDayAll(metrics);
  const metricValue = (type: string) => aggregated.get(type)?.value ?? null;

  const data = {
    plannedCount,
    completedCount,
    skippedCount,
    plannedMinutes: minutes.plannedMinutes,
    completedMinutes: minutes.completedMinutes,
    categoryMinutes: JSON.stringify(minutes.categoryMinutes),
    habitsDue: habitTotals.due,
    habitsDone: habitTotals.done,
    habitsSkipped: habitTotals.skipped,
    habitsMissed: habitTotals.missed,
    habitsPaused: habitTotals.paused,
    calories,
    protein,
    carbs,
    fat,
    fiber,
    mealCount: meals.length,
    nutritionTargetsMet,
    nutritionTargetsTotal,
    workoutCount: workouts.length,
    workoutMinutes,
    caloriesBurned,
    workoutVolumeKg: workoutFacts.workoutVolumeKg,
    workoutTypes: JSON.stringify(workoutFacts.workoutTypes),
    dayType,
    tasksCreated,
    tasksCompleted,
    tasksDueOpen,
    spendCents: finance.spendCents,
    incomeCents: finance.incomeCents,
    transactionCount: finance.transactionCount,
    spendByCategory: JSON.stringify(finance.spendByCategory),
    hasJournal: journal !== null,
    steps: metricValue("steps"),
    sleepHours: metricValue("sleep_hours"),
    bodyWeight: metricValue("body_weight"),
    restingHr: metricValue("resting_hr"),
    hrv: metricValue("hrv"),
    activeCalories: metricValue("active_calories"),
    hydrationMl: metricValue("hydration_ml"),
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

/**
 * The daily fact layer's read side: the stored summaries of a range as typed
 * `DailyFact` records with null semantics resolved. O(days in range) — one
 * indexed query plus an O(1) map per row; nothing here re-reads module data.
 */
export async function getDailyFacts(userId: string, from: DayKey, to: DayKey) {
  const summaries = await getSummaries(userId, from, to);
  return summaries.map(dailyFactFromSummary);
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
 * Recompute an explicit, deduplicated set of days with the same bounded
 * concurrency the rebuild uses — for writes that touch a handful of scattered
 * days (a task edit moving a due date, an account delete taking its ledger).
 * No ±6 expansion: callers use this for facts that live on their own day.
 */
export async function recomputeDaysFor(userId: string, dates: Iterable<DayKey>): Promise<number> {
  return recomputeDays(userId, [...new Set(dates)].sort());
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
