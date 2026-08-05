import { type DayKey, formatMinute, minuteToTimeValue, shiftDay } from "@/lib/date";

import {
  createStableDateKey,
  DEFAULT_DAY_RESET_MINUTE,
  nowMinuteIn,
  wallClockToInstant,
} from "./schedule";

export { DEFAULT_DAY_RESET_MINUTE };

/**
 * The operational day.
 *
 * The app's calendar is built on `YYYY-MM-DD` day keys, and historically a day
 * flipped at midnight. Real evenings don't: a planner block at 1:00 AM is the
 * tail of tonight's schedule, not the start of tomorrow's. The *operational
 * day* fixes this with one user setting — the **daily reset time** (default
 * 4:00 AM, stored as minutes after midnight in `User.dayResetMinute`):
 *
 *   Wednesday's operational day = Wednesday 4:00 AM → Thursday 3:59:59 AM,
 *   resolved in the user's configured timezone.
 *
 * Two rules keep the rest of the app simple:
 *
 *  1. Timestamps never change. An event at Thursday 1:00 AM still displays
 *     Thursday 1:00 AM — it is merely *grouped* under Wednesday.
 *  2. Only genuinely time-of-day data regroups. Date-only records (finance
 *     transactions, habit logs, Apple Health daily aggregates) already store
 *     the day they belong to; the reset only changes which day key *new*
 *     writes default to, via `currentOperationalDay`.
 *
 * This module is the single authority for that boundary. Nothing else in the
 * codebase may subtract four hours by hand.
 */

/**
 * The latest allowed reset: 6:00 AM. Past that, "yesterday" would cover most
 * of a working morning, and every screen that says "today" becomes a riddle.
 */
export const MAX_DAY_RESET_MINUTE = 6 * 60;

export function isValidDayResetMinute(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DAY_RESET_MINUTE
  );
}

/**
 * The operational date an instant belongs to: the calendar date in the user's
 * timezone, minus one day when the wall clock reads before the reset.
 */
export function operationalDayOf(
  instant: Date,
  timezone: string | null | undefined,
  resetMinute: number,
): DayKey {
  const calendarDay = createStableDateKey(instant, timezone);
  if (resetMinute <= 0) return calendarDay;
  const wallMinute = nowMinuteIn(timezone, instant);
  return wallMinute < resetMinute ? shiftDay(calendarDay, -1) : calendarDay;
}

/** The operational date right now (or at an injected `now`, for tests). */
export function currentOperationalDay(
  timezone: string | null | undefined,
  resetMinute: number,
  now: Date = new Date(),
): DayKey {
  return operationalDayOf(now, timezone, resetMinute);
}

/** True while the wall clock is between midnight and the reset. */
export function isBeforeReset(
  instant: Date,
  timezone: string | null | undefined,
  resetMinute: number,
): boolean {
  if (resetMinute <= 0) return false;
  return nowMinuteIn(timezone, instant) < resetMinute;
}

/**
 * The real instants an operational day spans: `[start, end)` — reset time on
 * its calendar date through reset time the next day, resolved in the user's
 * timezone. DST is handled by `wallClockToInstant` (a nonexistent 4:00 AM on
 * a spring-forward day resolves to the instant the clocks land on), so the
 * window is always contiguous with its neighbours: 23 hours on spring
 * forward, 25 on fall back.
 */
export function operationalDayWindow(
  day: DayKey,
  timezone: string | null | undefined,
  resetMinute: number,
): { start: Date; end: Date } {
  const time = minuteToTimeValue(resetMinute);
  const start = wallClockToInstant(`${day}T${time}`, timezone);
  const end = wallClockToInstant(`${shiftDay(day, 1)}T${time}`, timezone);
  // wallClockToInstant only returns null for malformed input; day keys and
  // minuteToTimeValue output are well-formed by construction.
  if (!start || !end) throw new Error(`Could not resolve operational window for ${day}`);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Planner records: a calendar date plus minutes-from-midnight
// ---------------------------------------------------------------------------

/**
 * A minute positioned on the operational day's extended axis. Times at or
 * after the reset keep their wall-clock value (9:00 AM → 540); times before
 * it — the after-midnight tail — are pushed past 1440 (1:00 AM → 1500) so
 * they sort and render at the end of the day they belong to. Wall-clock
 * display is untouched; this is a sort/render position, never a label.
 */
export function operationalSortMinute(wallMinute: number, resetMinute: number): number {
  if (resetMinute <= 0) return wallMinute;
  return wallMinute < resetMinute ? wallMinute + 1440 : wallMinute;
}

export interface OperationalDayRecord {
  /** Calendar date, `YYYY-MM-DD` — never rewritten. */
  date: DayKey;
  /** Minutes from midnight, or null for untimed/all-day records. */
  startMinute: number | null;
}

/**
 * The operational day a planner-style record belongs to. Timed records before
 * the reset group with the previous day; untimed and all-day records belong
 * to their calendar date — a date-only record has no time to judge by.
 */
export function operationalDayOfRecord(record: OperationalDayRecord, resetMinute: number): DayKey {
  if (resetMinute <= 0 || record.startMinute === null || record.startMinute >= resetMinute) {
    return record.date;
  }
  return shiftDay(record.date, -1);
}

/** Whether a record renders under the previous day purely because of the reset. */
export function isGroupedWithPreviousDay(record: OperationalDayRecord, resetMinute: number): boolean {
  return operationalDayOfRecord(record, resetMinute) !== record.date;
}

/** Does this record belong to operational day `day`? */
export function belongsToOperationalDay(
  record: OperationalDayRecord,
  day: DayKey,
  resetMinute: number,
): boolean {
  return operationalDayOfRecord(record, resetMinute) === day;
}

/**
 * The calendar dates whose records can belong to operational day `day` —
 * the day itself plus, when a reset is set, the after-midnight tail of the
 * next calendar date. This is what a database query should span before
 * filtering with `belongsToOperationalDay`.
 */
export function operationalDayDates(day: DayKey, resetMinute: number): DayKey[] {
  return resetMinute > 0 ? [day, shiftDay(day, 1)] : [day];
}

/**
 * Where a new record with this start time belongs: entering "1:00 AM" while
 * planning operational day `day` means the small hours of the *next* calendar
 * date. The inverse of `operationalDayOfRecord`, used on the write path so a
 * round trip lands the record back on the day the user was looking at.
 */
export function calendarDateForOperationalTime(
  day: DayKey,
  startMinute: number | null,
  resetMinute: number,
): DayKey {
  if (resetMinute <= 0 || startMinute === null || startMinute >= resetMinute) return day;
  return shiftDay(day, 1);
}

/**
 * A Prisma-shaped filter matching exactly the planner records of one
 * operational day — `belongsToOperationalDay` as SQL. Spread it into a
 * `where` alongside `userId`.
 */
export function operationalDayWhere(
  day: DayKey,
  resetMinute: number,
): { date: DayKey } | { OR: Array<Record<string, unknown>> } {
  if (resetMinute <= 0) return { date: day };
  return {
    OR: [
      { date: day, startMinute: null },
      { date: day, startMinute: { gte: resetMinute } },
      { date: shiftDay(day, 1), startMinute: { lt: resetMinute } },
    ],
  };
}

/** The range form: planner records of every operational day in `[from, to]`. */
export function operationalRangeWhere(
  from: DayKey,
  to: DayKey,
  resetMinute: number,
): { date: { gte: DayKey; lte: DayKey } } | { OR: Array<Record<string, unknown>> } {
  if (resetMinute <= 0) return { date: { gte: from, lte: to } };
  return {
    OR: [
      { date: { gte: from, lte: to }, startMinute: null },
      { date: { gte: from, lte: to }, startMinute: { gte: resetMinute } },
      { date: { gte: shiftDay(from, 1), lte: shiftDay(to, 1) }, startMinute: { lt: resetMinute } },
    ],
  };
}

/**
 * The naive wall-clock string (`YYYY-MM-DDTHH:mm:00`) at which a reminder
 * minute on an operational day actually occurs. A 9:00 AM reminder for
 * operational Wednesday is Wednesday 9:00 AM; a 1:00 AM reminder is Thursday
 * 1:00 AM — it still fires at its real time, on its real date.
 */
export function operationalWallClock(day: DayKey, minute: number, resetMinute: number): string {
  const date = calendarDateForOperationalTime(day, minute, resetMinute);
  return `${date}T${minuteToTimeValue(minute)}:00`;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** "4:00 AM" */
export function formatResetTime(resetMinute: number): string {
  return formatMinute(resetMinute);
}

/**
 * The hint shown on records grouped under the previous day:
 * "Grouped with Wednesday because your day resets at 4:00 AM."
 */
export function groupedWithDayHint(dayLabel: string, resetMinute: number): string {
  return `Grouped with ${dayLabel} because your day resets at ${formatResetTime(resetMinute)}.`;
}
