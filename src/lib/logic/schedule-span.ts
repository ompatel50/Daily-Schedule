import { type DayKey, shiftDay } from "@/lib/date";

/**
 * Planner span geometry: where a timed block really starts and ends, and the
 * one chronological order every planner surface sorts by.
 *
 * ## Cross-midnight spans
 *
 * A `ScheduleItem` stores its start's calendar `date` plus `startMinute` /
 * `endMinute` as minutes-from-midnight (0..1439). An **end clock earlier than
 * the start clock means the block runs past midnight**: 11:45 PM → 12:15 AM on
 * Aug 17 is one continuous 30-minute block ending Aug 18 at 12:15 AM. Nothing
 * else changes — the stored `date` stays the start's real calendar date, so
 * operational-day grouping (keyed on the start, see
 * `src/lib/logic/operational-day.ts`), series slots and rollover all compose
 * unchanged.
 *
 * An end **equal** to the start stays what it always was: a zero-duration
 * point item ("Wake up — 9:00 AM"), never a 24-hour block. The longest
 * representable timed block is therefore 23 h 59 m, which is fine — a planner
 * block that long is an all-day item.
 *
 * Durations here are wall-clock durations: 11:45 PM → 12:15 AM is 30 minutes
 * in the user's local time on either side of a DST transition, because both
 * clocks are wall times and DST switches happen later in the night. (The rare
 * block that actually contains a transition is measured in wall minutes, the
 * same convention every minute in this app uses.)
 */

/** True when a timed span's end clock reads earlier than its start — the
 * block crosses midnight and ends on the NEXT calendar day. */
export function crossesMidnight(
  startMinute: number | null | undefined,
  endMinute: number | null | undefined,
): boolean {
  return (
    startMinute !== null &&
    startMinute !== undefined &&
    endMinute !== null &&
    endMinute !== undefined &&
    endMinute < startMinute
  );
}

/**
 * The end minute on the start date's extended axis (0..2879): a wrapped end
 * moves past 1440 so `resolvedEndMinute - startMinute` is always the real
 * duration. Equal start/end stays 0-length.
 */
export function resolvedEndMinute(startMinute: number, endMinute: number): number {
  return endMinute < startMinute ? endMinute + 1440 : endMinute;
}

/** Wall-clock duration in minutes; null when either bound is missing. */
export function spanDurationMinutes(
  startMinute: number | null,
  endMinute: number | null,
): number | null {
  if (startMinute === null || endMinute === null) return null;
  return resolvedEndMinute(startMinute, endMinute) - startMinute;
}

/** The calendar date a span's END falls on — the next day when it wraps. */
export function endDateOf(
  date: DayKey,
  startMinute: number | null,
  endMinute: number | null,
): DayKey {
  return crossesMidnight(startMinute, endMinute) ? shiftDay(date, 1) : date;
}

// ---------------------------------------------------------------------------
// The chronological order
// ---------------------------------------------------------------------------

/** What the comparator needs to know about a row. Structurally satisfied by
 * `ScheduleRowItem`, Prisma rows and `ConflictCandidate`s alike. */
export interface PlannerSpanLike {
  /** Calendar date (`YYYY-MM-DD`) of the span's START. Optional only for
   * legacy single-day callers — omitted on both sides means "same date". */
  date?: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  /** Manual drag order — the long-standing stable ordering field. */
  sortOrder?: number | null;
  id?: string;
}

/**
 * The planner's one chronological comparator. Every surface that lists
 * schedule items in time order sorts with this, so the day list, the
 * timeline, week/month cells, summaries and the assistant can never disagree.
 *
 * Sort keys, in order:
 *
 *  1. **Calendar date of the start**, ascending. Day keys compare
 *     lexicographically, and because an operational day's after-midnight tail
 *     is *stored* on the next calendar date, date-then-minute IS the
 *     operational day's extended axis — Monday 11:45 PM sorts before Tuesday
 *     12:15 AM with no reset arithmetic at all.
 *  2. **Untimed/all-day placement** within the date: first by default (the
 *     day list pins the unscheduled backlog on top), last where a surface
 *     reads better bottom-up (week/month cells).
 *  3. **Start minute**, ascending — earlier starts first.
 *  4. **Resolved end**, ascending — on identical starts the earlier-*finishing*
 *     block comes first: a 9:00 AM point item, then 9:00–9:30, then
 *     9:00–10:00. A cross-midnight end resolves past 1440, so it sorts after
 *     every same-start same-day end. A missing end counts as a point.
 *  5. **`sortOrder`**, then **`id`** — the deterministic fallback. `sortOrder`
 *     is the existing manual-ordering field; `id` (a cuid, monotonic in
 *     creation time) settles anything left so the order never depends on
 *     database return order.
 */
export function comparePlannerSpans(
  a: PlannerSpanLike,
  b: PlannerSpanLike,
  untimed: "first" | "last" = "first",
): number {
  const aDate = a.date ?? "";
  const bDate = b.date ?? "";
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;

  const aUntimed = a.allDay || a.startMinute === null;
  const bUntimed = b.allDay || b.startMinute === null;
  if (aUntimed !== bUntimed) {
    return aUntimed === (untimed === "first") ? -1 : 1;
  }

  if (!aUntimed) {
    const startDiff = (a.startMinute as number) - (b.startMinute as number);
    if (startDiff !== 0) return startDiff;

    const aEnd =
      a.endMinute === null
        ? (a.startMinute as number)
        : resolvedEndMinute(a.startMinute as number, a.endMinute);
    const bEnd =
      b.endMinute === null
        ? (b.startMinute as number)
        : resolvedEndMinute(b.startMinute as number, b.endMinute);
    if (aEnd !== bEnd) return aEnd - bEnd;
  }

  const orderDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (orderDiff !== 0) return orderDiff;

  const aId = a.id ?? "";
  const bId = b.id ?? "";
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

/** `.sort(plannerChronology)` — the comparator with its defaults. */
export function plannerChronology(a: PlannerSpanLike, b: PlannerSpanLike): number {
  return comparePlannerSpans(a, b);
}
