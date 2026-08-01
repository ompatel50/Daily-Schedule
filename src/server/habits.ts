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
  getNextScheduledDate,
  getOccurrenceForDate,
  getStatusForDate,
  getWeekBounds,
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

  /**
   * The next scheduled opportunity strictly AFTER the requested date, or null.
   *
   * Only computed when `nextDueScanDays` is set — the scan walks day by day,
   * and the surfaces that render today's checklist have no use for it, so they
   * should not pay for it.
   */
  nextDueDate: DayKey | null;

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
  /**
   * How far ahead to look for `nextDueDate`. 0 (the default) skips the scan
   * entirely, which is what every checklist surface wants.
   */
  nextDueScanDays?: number;
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
    options.nextDueScanDays ?? 0,
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
  nextDueScanDays: number,
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

      nextDueDate:
        nextDueScanDays > 0
          ? getNextScheduledDate(item, date, settings, nextDueScanDays)
          : null,

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

// ---------------------------------------------------------------------------
// Habit status — the compact summary
// ---------------------------------------------------------------------------

/**
 * One habit reduced to the facts a status answer needs.
 *
 * A projection of `HabitView`, not a second model: the streaks, weekly
 * progress and completion rates below are the same numbers the habits page
 * renders, computed by the same schedule engine. What is dropped is
 * presentation (icon, colour, sort order, the full day-state strip) and what
 * is added is derived from what stays — the days already missed this week.
 */
export interface HabitStatusEntry {
  id: string;
  name: string;
  category: string;
  /** Human-readable recurrence, e.g. "Every day" or "3× per week". */
  schedule: string;
  /** Resolved status for the requested date. */
  status: DayStatus;
  statusLabel: string;
  dueToday: boolean;
  /** A times-per-week habit: available today, judged over the week. */
  flexibleToday: boolean;
  loggedStatus: string | null;
  loggedValue: number | null;
  /** e.g. "8 glasses", when the habit carries a numeric target. */
  target: string | null;
  streak: { current: number; longest: number; unit: "occurrences" | "weeks" };
  /** Progress across the week containing the requested date. */
  week: { done: number; target: number; remaining: number; percent: number };
  /** Days in that week, up to the requested date, that were missed or skipped. */
  missedThisWeek: DayKey[];
  history: {
    days: number;
    opportunities: number;
    completed: number;
    missed: number;
    /** completed / opportunities as a percentage, or null with no opportunity. */
    completionRate: number | null;
  };
  /** Next scheduled opportunity after the requested date, if any is near. */
  nextDueDate: DayKey | null;
  archived: boolean;
}

export interface HabitStatusSummary {
  date: DayKey;
  week: { start: DayKey; end: DayKey };
  /** Scheduled-opportunity counts for the requested date. */
  totals: HabitDayTotals;
  habits: HabitStatusEntry[];
  /** How many habits matched before the bound below was applied. */
  matched: number;
  /** True when `habits` is a prefix of the matches, not all of them. */
  truncated: boolean;
}

export interface HabitStatusOptions {
  includeArchived?: boolean;
  /** Case-insensitive substring match on the habit name. */
  name?: string;
  /** Window for the completion-rate figures. */
  historyDays?: number;
  /** How far ahead to look for the next scheduled day. */
  nextDueScanDays?: number;
  /** Hard cap on returned habits — the result must stay small. */
  limit?: number;
}

/**
 * Bounds, so a status answer stays a status answer.
 *
 * `limit` is set by the assistant's tool-result ceiling, not by taste: an
 * entry serializes to roughly 400 bytes, and the registry cuts any result
 * past ASSISTANT_LIMITS.maxToolResultChars (8 KB) into an unusable fragment.
 * Twelve leaves headroom for long habit names; past that the caller is told
 * the list was cut so it can ask by name instead.
 */
const HABIT_STATUS_DEFAULTS = {
  historyDays: 30,
  nextDueScanDays: 60,
  limit: 12,
} as const;

/**
 * Every habit's current standing on one date: done, missed, pending, streaks,
 * this week's progress and when each is next due.
 *
 * Built on `getHabitViews`, so ownership, the schedule engine and the streak
 * rules are the app's existing ones — this adds shaping and bounds, nothing
 * else. `userId` is always the caller's own, resolved by the caller.
 */
export async function getHabitStatusSummary(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  options: HabitStatusOptions = {},
): Promise<HabitStatusSummary> {
  const historyDays = options.historyDays ?? HABIT_STATUS_DEFAULTS.historyDays;
  const limit = Math.min(Math.max(options.limit ?? HABIT_STATUS_DEFAULTS.limit, 1), 100);
  const week = getWeekBounds(date, settings);

  const [views, totals] = await Promise.all([
    getHabitViews(userId, date, settings, {
      includeArchived: options.includeArchived ?? false,
      historyDays,
      // The strip only has to reach back to the start of the week containing
      // `date` — at most six days — for `missedThisWeek` to be complete.
      stripDays: 6,
      nextDueScanDays: options.nextDueScanDays ?? HABIT_STATUS_DEFAULTS.nextDueScanDays,
    }),
    getHabitDayTotals(userId, date, settings),
  ]);

  const needle = options.name?.trim().toLowerCase() ?? "";
  const matches = needle
    ? views.filter((view) => view.name.toLowerCase().includes(needle))
    : views;

  return {
    date,
    week: { start: week.start, end: week.end },
    totals,
    matched: matches.length,
    truncated: matches.length > limit,
    habits: matches.slice(0, limit).map((view) => ({
      id: view.id,
      name: view.name,
      category: view.category,
      schedule: view.scheduleSummary,
      status: view.status,
      statusLabel: view.statusLabel,
      dueToday: view.dueToday,
      flexibleToday: view.flexibleToday,
      loggedStatus: view.loggedStatus,
      loggedValue: view.loggedValue,
      target:
        view.targetValue === null
          ? null
          : `${view.targetValue}${view.unit ? ` ${view.unit}` : ""}`,
      streak: {
        current: view.streak,
        longest: view.longestStreak,
        unit: view.streakUnit,
      },
      week: {
        done: view.weekly.done,
        target: view.weekly.target,
        remaining: view.weekly.remaining,
        percent: view.weekly.percent,
      },
      missedThisWeek: view.dayStates
        .filter(
          (day) =>
            day.date >= week.start &&
            (day.status === "missed" || day.status === "skipped"),
        )
        .map((day) => day.date),
      history: {
        days: historyDays,
        opportunities: view.opportunities,
        completed: view.completed,
        missed: view.missed,
        completionRate: view.completionRate,
      },
      nextDueDate: view.nextDueDate,
      archived: view.archived,
    })),
  };
}
