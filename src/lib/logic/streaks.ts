import { type DayKey, dayRange, daysBetween, shiftDay, today, weekDays } from "@/lib/date";
import { isHabitDue } from "./recurrence";

export interface HabitLike {
  id: string;
  frequency: string;
  weekdays: number[];
  targetPerWeek: number;
  startDate: DayKey;
  endDate?: string | null;
}

export interface LogLike {
  date: DayKey;
  status: string; // done | skipped | missed
  value?: number | null;
}

export interface StreakStats {
  /** Consecutive due-days completed, counting back from today. */
  current: number;
  longest: number;
  /** Completed / due within the analysed window, 0–100. */
  completionRate: number;
  totalDone: number;
  totalDue: number;
  totalMissed: number;
  /** Days since the habit was last completed; null if never. */
  daysSinceLast: number | null;
}

/**
 * Streak rules (documented because every habit app picks slightly different
 * ones):
 *  - Only *due* days count toward or break a streak.
 *  - `skipped` is a deliberate rest day: it neither extends nor breaks a streak.
 *  - Today not-yet-logged does not break the streak (the day isn't over).
 *  - Missing a due day in the past breaks it.
 */
export function computeStreaks(
  habit: HabitLike,
  logs: LogLike[],
  options: { from?: DayKey; to?: DayKey } = {},
): StreakStats {
  const to = options.to ?? today();
  const from = options.from ?? habit.startDate;
  const byDate = new Map(logs.map((log) => [log.date, log]));

  const window = daysBetween(from, to) < 0 ? [] : dayRange(from, to);
  const dueDays = window.filter((day) => isHabitDue(habit, day));

  let totalDone = 0;
  let totalMissed = 0;
  let longest = 0;
  let running = 0;

  for (const day of dueDays) {
    const log = byDate.get(day);
    if (log?.status === "done") {
      totalDone += 1;
      running += 1;
      longest = Math.max(longest, running);
    } else if (log?.status === "skipped") {
      // Neutral: preserves the streak without counting as a completion.
      continue;
    } else {
      if (day !== to) totalMissed += 1;
      running = 0;
    }
  }

  // Current streak walks backwards from today.
  let current = 0;
  let cursor = to;
  // An unlogged *today* is still in progress — start from yesterday instead.
  if (isHabitDue(habit, cursor) && byDate.get(cursor)?.status !== "done") {
    if (byDate.get(cursor)?.status === undefined || byDate.get(cursor)?.status === "skipped") {
      cursor = shiftDay(cursor, -1);
    }
  }
  while (daysBetween(habit.startDate, cursor) >= 0) {
    if (!isHabitDue(habit, cursor)) {
      cursor = shiftDay(cursor, -1);
      continue;
    }
    const status = byDate.get(cursor)?.status;
    if (status === "done") current += 1;
    else if (status === "skipped") {
      /* neutral */
    } else break;
    cursor = shiftDay(cursor, -1);
  }

  const doneDates = logs
    .filter((log) => log.status === "done")
    .map((log) => log.date)
    .sort();
  const last = doneDates[doneDates.length - 1];

  return {
    current,
    longest: Math.max(longest, current),
    completionRate: dueDays.length === 0 ? 0 : Math.round((totalDone / dueDays.length) * 100),
    totalDone,
    totalDue: dueDays.length,
    totalMissed,
    daysSinceLast: last ? daysBetween(last, to) : null,
  };
}

/**
 * For `weekly` habits the meaningful number is "N of M this week".
 */
export function weeklyProgress(
  habit: HabitLike,
  logs: LogLike[],
  day: DayKey = today(),
  weekStartsOn: 0 | 1 = 1,
): { done: number; target: number; days: DayKey[] } {
  const days = weekDays(day, weekStartsOn);
  const dates = new Set(days);
  const done = logs.filter((log) => dates.has(log.date) && log.status === "done").length;
  return { done, target: Math.max(1, habit.targetPerWeek), days };
}

/**
 * Consistency across *all* habits for one day: how many due habits were done.
 */
export function dayHabitCompletion(
  habits: HabitLike[],
  logs: LogLike[] & { habitId?: string }[],
  day: DayKey,
): { due: number; done: number } {
  const logsByHabit = new Map<string, LogLike>();
  for (const log of logs as Array<LogLike & { habitId: string }>) {
    if (log.date === day) logsByHabit.set(log.habitId, log);
  }
  let due = 0;
  let done = 0;
  for (const habit of habits) {
    if (!isHabitDue(habit, day)) continue;
    due += 1;
    if (logsByHabit.get(habit.id)?.status === "done") done += 1;
  }
  return { due, done };
}
