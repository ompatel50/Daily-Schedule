import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
  subDays,
} from "date-fns";

/**
 * Calendar days are represented as `YYYY-MM-DD` strings ("day keys") everywhere
 * in this app — in the DB, in URLs and in component props.
 *
 * Why not Date objects? A `Date` is an instant, and an instant rendered in a
 * different timezone can be a different calendar day. Since the whole product
 * is organised around "what did I do on this day", a timezone-free day key is
 * both simpler and less buggy. Conversion to/from `Date` happens only at the
 * edges, always in the browser/server *local* timezone.
 */
export type DayKey = string;

export const DAY_FORMAT = "yyyy-MM-dd";

export function toDayKey(date: Date): DayKey {
  return format(date, DAY_FORMAT);
}

export function fromDayKey(day: DayKey): Date {
  const parsed = parse(day, DAY_FORMAT, new Date());
  if (!isValid(parsed)) throw new Error(`Invalid day key: ${day}`);
  // Normalise to local noon so DST transitions can never shift the day.
  parsed.setHours(12, 0, 0, 0);
  return parsed;
}

export function isDayKey(value: unknown): value is DayKey {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isValid(parse(value, DAY_FORMAT, new Date()));
}

export function today(): DayKey {
  return toDayKey(new Date());
}

export function shiftDay(day: DayKey, amount: number): DayKey {
  return toDayKey(addDays(fromDayKey(day), amount));
}

export function shiftMonth(day: DayKey, amount: number): DayKey {
  return toDayKey(addMonths(fromDayKey(day), amount));
}

export function daysBetween(from: DayKey, to: DayKey): number {
  return differenceInCalendarDays(fromDayKey(to), fromDayKey(from));
}

/** Inclusive list of day keys between two days. */
export function dayRange(from: DayKey, to: DayKey): DayKey[] {
  const total = daysBetween(from, to);
  if (total < 0) return [];
  return Array.from({ length: total + 1 }, (_, i) => shiftDay(from, i));
}

/** The last `count` days ending at (and including) `end`. */
export function lastNDays(count: number, end: DayKey = today()): DayKey[] {
  return dayRange(toDayKey(subDays(fromDayKey(end), count - 1)), end);
}

export function weekRange(day: DayKey, weekStartsOn: 0 | 1 = 1): { start: DayKey; end: DayKey } {
  const date = fromDayKey(day);
  return {
    start: toDayKey(startOfWeek(date, { weekStartsOn })),
    end: toDayKey(endOfWeek(date, { weekStartsOn })),
  };
}

export function weekDays(day: DayKey, weekStartsOn: 0 | 1 = 1): DayKey[] {
  const { start, end } = weekRange(day, weekStartsOn);
  return dayRange(start, end);
}

export function monthRange(day: DayKey): { start: DayKey; end: DayKey } {
  const date = fromDayKey(day);
  return { start: toDayKey(startOfMonth(date)), end: toDayKey(endOfMonth(date)) };
}

/** Full weeks covering a month — what a month grid needs. */
export function monthGridDays(day: DayKey, weekStartsOn: 0 | 1 = 1): DayKey[] {
  const date = fromDayKey(day);
  const start = startOfWeek(startOfMonth(date), { weekStartsOn });
  const end = endOfWeek(endOfMonth(date), { weekStartsOn });
  return dayRange(toDayKey(start), toDayKey(end));
}

export function weekdayOf(day: DayKey): number {
  return fromDayKey(day).getDay();
}

/*
 * `today()` reads the host clock. The server resolves the real day from the
 * user's configured timezone (`getToday()`), and the two disagree for several
 * hours a day whenever the machine's zone is not the user's — which is how the
 * Today page came to be titled "Yesterday".
 *
 * Every one of these takes the reference day as an argument so a caller that
 * knows the user's day can pass it. The host clock stays the default only
 * because the alternative is threading it through every component at once.
 */

export function isToday(day: DayKey, reference: DayKey = today()): boolean {
  return day === reference;
}

export function isPast(day: DayKey, reference: DayKey = today()): boolean {
  return daysBetween(day, reference) > 0;
}

export function isFuture(day: DayKey, reference: DayKey = today()): boolean {
  return daysBetween(reference, day) > 0;
}

export function isSameMonth(a: DayKey, b: DayKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

// --- display helpers --------------------------------------------------------

export function formatDay(day: DayKey, pattern = "EEE, MMM d"): string {
  return format(fromDayKey(day), pattern);
}

export function formatDayLong(day: DayKey): string {
  return format(fromDayKey(day), "EEEE, MMMM d, yyyy");
}

export function formatMonthTitle(day: DayKey): string {
  return format(fromDayKey(day), "MMMM yyyy");
}

/** "Today", "Yesterday", "Tomorrow" or a formatted date. */
export function relativeDayLabel(day: DayKey, reference: DayKey = today()): string {
  const delta = daysBetween(reference, day);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta > 1 && delta < 7) return formatDay(day, "EEEE");
  return formatDay(day, "MMM d");
}

export function formatWeekRange(day: DayKey, weekStartsOn: 0 | 1 = 1): string {
  const { start, end } = weekRange(day, weekStartsOn);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${formatDay(start, "MMM d")} – ${formatDay(end, "d, yyyy")}`
    : `${formatDay(start, "MMM d")} – ${formatDay(end, "MMM d, yyyy")}`;
}

// --- time-of-day helpers ----------------------------------------------------

/** Minutes-from-midnight → "7:30 AM". */
export function formatMinute(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

/** "07:30" → 450 */
export function parseTimeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** 450 → "07:30" (for `<input type="time">`). */
export function minuteToTimeValue(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatTimeRange(start: number | null, end: number | null, allDay: boolean): string {
  if (allDay || start === null) return "All day";
  if (end === null || end === start) return formatMinute(start);
  return `${formatMinute(start)} – ${formatMinute(end)}`;
}

/** Current minute-from-midnight, used for the "now" line on the timeline. */
export function nowMinute(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

export function weekdayLabelsFor(weekStartsOn: 0 | 1): string[] {
  return weekStartsOn === 1
    ? [...WEEKDAY_LABELS.slice(1), WEEKDAY_LABELS[0]]
    : WEEKDAY_LABELS;
}
