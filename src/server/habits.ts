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
import { cache } from "react";

import { prisma } from "@/lib/prisma";
import { type DayKey, dayRange, shiftDay } from "@/lib/date";
import {
  calculateCompletionRate,
  calculateScheduledStreak,
  calculateWeeklyProgress,
  describeSchedule,
  getOccurrenceForDate,
  getStatusForDate,
  resolveEffectiveSchedule,
  type CompletionLike,
  type DayStatus,
  type Occurrence,
  type ScheduleRuleLike,
  type ScheduleSettings,
  type WeeklyProgress,
} from "@/lib/logic/schedule";
import { loadSchedules, toSchedulable } from "@/server/schedule";

/**
 * Habit read model, built on the shared schedule engine.
 *
 * Before this existed, habit due-ness was decided by `isHabitDue`, which
 * treated a "3 times per week" habit as due every single day — so it showed
 * four missed days a week and its streak broke constantly. Habits now resolve
 * through exactly the same code as goals.
 */

export interface HabitView {
  id: string;
  name: string;
  description: string | null;
  category: string;
  icon: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  startDate: DayKey;
  endDate: string | null;

  /** Resolved state for the requested date. */
  occurrence: Occurrence;
  status: DayStatus;
  statusLabel: string;
  /** True when the habit places a real requirement on this date. */
  dueToday: boolean;
  /** True for a times-per-week habit: available today, judged weekly. */
  flexibleToday: boolean;
  loggedStatus: string | null;
  loggedValue: number | null;

  daypart: string;
  timeMinute: number | null;
  reminderEnabled: boolean;
  reminderMinute: number | null;

  scheduleSummary: string;
  rule: ScheduleRuleLike | null;

  streak: number;
  longestStreak: number;
  streakUnit: "occurrences" | "weeks";
  /** Completed / scheduled opportunities in the history window, or null. */
  completionRate: number | null;
  opportunities: number;
  completed: number;
  missed: number;

  weekly: WeeklyProgress;
  targetValue: number | null;
  unit: string | null;

  recentLogs: Array<{ date: string; status: string }>;
  /**
   * Resolved status per day across the history window. The habit-history strip
   * renders straight from this instead of re-deciding due-ness in the browser,
   * which is how the client and server used to disagree.
   */
  dayStates: Array<{ date: DayKey; status: DayStatus; label: string }>;
}

export interface HabitViewOptions {
  includeArchived?: boolean;
  /** Window used for streaks and completion rate. */
  historyDays?: number;
  /** Window used for the per-day history strip. */
  stripDays?: number;
}

/**
 * Every habit resolved for `date`, with streaks and rates computed over
 * scheduled opportunities.
 *
 * Two queries regardless of habit count — the schedules and the logs are both
 * batch-loaded, so adding habits does not add round trips.
 */
export async function getHabitViews(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  options: HabitViewOptions = {},
): Promise<HabitView[]> {
  // Request-level memo with options normalised to primitives, so the several
  // surfaces that need today's habit views in one render share one load.
  return getHabitViewsMemo(
    userId,
    date,
    settings,
    options.historyDays ?? 90,
    options.stripDays ?? -1,
    options.includeArchived ?? false,
  );
}

const getHabitViewsMemo = cache(getHabitViewsImpl);

async function getHabitViewsImpl(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  historyDays: number,
  stripDaysOption: number,
  includeArchived: boolean,
): Promise<HabitView[]> {
  const options: HabitViewOptions = {
    historyDays,
    ...(stripDaysOption === -1 ? {} : { stripDays: stripDaysOption }),
    includeArchived,
  };
  const from = shiftDay(date, -historyDays);

  const habits = await prisma.habit.findMany({
    where: { userId, ...(options.includeArchived ? {} : { archived: false }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { logs: { where: { date: { gte: from } }, orderBy: { date: "asc" } } },
  });
  if (habits.length === 0) return [];

  const schedules = await loadSchedules(
    userId,
    "habit",
    habits.map((habit) => habit.id),
  );

  return habits.map((habit) => {
    const item = toSchedulable(
      {
        id: habit.id,
        startDate: habit.startDate,
        endDate: habit.endDate,
        enabled: !habit.archived,
      },
      schedules.get(habit.id),
    );

    const completions: CompletionLike[] = habit.logs.map((log) => ({
      date: log.date,
      status: log.status,
      value: log.value,
    }));
    const todayLog = habit.logs.find((log) => log.date === date) ?? null;

    const occurrence = getOccurrenceForDate(item, date, settings);
    const resolved = getStatusForDate(item, date, todayLog, settings);
    const rule = resolveEffectiveSchedule(item, date);
    const stats = calculateCompletionRate(item, from, date, completions, settings);
    const streak = calculateScheduledStreak(item, date, completions, settings);
    const weekly = calculateWeeklyProgress(item, date, completions, settings);

    const logByDate = new Map(completions.map((completion) => [completion.date, completion]));
    const historyFrom = shiftDay(date, -(options.stripDays ?? 27));
    const dayStates = dayRange(historyFrom, date).map((day) => {
      const state = getStatusForDate(item, day, logByDate.get(day) ?? null, settings);
      return { date: day, status: state.status, label: state.label };
    });

    return {
      id: habit.id,
      name: habit.name,
      description: habit.description,
      category: habit.category,
      icon: habit.icon,
      color: habit.color,
      sortOrder: habit.sortOrder,
      archived: habit.archived,
      startDate: habit.startDate,
      endDate: habit.endDate,

      occurrence,
      status: resolved.status,
      statusLabel: resolved.label,
      dueToday: occurrence.active,
      flexibleToday: occurrence.flexible,
      loggedStatus: todayLog?.status ?? null,
      loggedValue: todayLog?.value ?? null,

      daypart: rule?.daypart ?? habit.timeOfDay,
      timeMinute: rule?.timeMinute ?? null,
      reminderEnabled: rule?.reminderEnabled ?? false,
      reminderMinute: rule?.reminderMinute ?? null,

      scheduleSummary: describeSchedule(rule),
      rule,

      streak: streak.current,
      longestStreak: streak.longest,
      streakUnit: streak.unit,
      completionRate: stats.rate,
      opportunities: stats.opportunities,
      completed: stats.completed,
      missed: stats.missed,

      weekly,
      targetValue: habit.targetValue,
      unit: habit.unit,

      recentLogs: habit.logs.map((log) => ({ date: log.date, status: log.status })),
      dayStates,
    };
  });
}

/**
 * Habit completion for one date, expressed as scheduled opportunities.
 *
 * This is what the day score and the calendar consume. A weekday habit
 * contributes nothing on a Saturday — it is not in the denominator at all,
 * rather than being counted as an unmet requirement.
 */
export interface HabitDayTotals {
  due: number;
  done: number;
  missed: number;
  skipped: number;
  excused: number;
  pending: number;
  restOrUnscheduled: number;
}

export async function getHabitDayTotals(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
): Promise<HabitDayTotals> {
  const habits = await prisma.habit.findMany({
    where: { userId, archived: false },
    select: { id: true, startDate: true, endDate: true, archived: true },
  });

  const totals: HabitDayTotals = {
    due: 0,
    done: 0,
    missed: 0,
    skipped: 0,
    excused: 0,
    pending: 0,
    restOrUnscheduled: 0,
  };
  if (habits.length === 0) return totals;

  const [schedules, logs] = await Promise.all([
    loadSchedules(
      userId,
      "habit",
      habits.map((habit) => habit.id),
    ),
    prisma.habitLog.findMany({
      where: { userId, date },
      select: { habitId: true, status: true, date: true, value: true },
    }),
  ]);

  const logByHabit = new Map(logs.map((log) => [log.habitId, log]));

  for (const habit of habits) {
    const item = toSchedulable(
      {
        id: habit.id,
        startDate: habit.startDate,
        endDate: habit.endDate,
        enabled: !habit.archived,
      },
      schedules.get(habit.id),
    );
    const resolved = getStatusForDate(item, date, logByHabit.get(habit.id) ?? null, settings);

    switch (resolved.status) {
      case "completed":
        totals.due += 1;
        totals.done += 1;
        break;
      case "missed":
        totals.due += 1;
        totals.missed += 1;
        break;
      case "skipped":
        totals.due += 1;
        totals.skipped += 1;
        break;
      case "pending":
        totals.due += 1;
        totals.pending += 1;
        break;
      case "excused":
        totals.excused += 1;
        break;
      case "future":
        break;
      default:
        totals.restOrUnscheduled += 1;
        break;
    }
  }

  return totals;
}
