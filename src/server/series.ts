import "server-only";

import { prisma } from "@/lib/db";
import { daysBetween, shiftDay, today, type DayKey } from "@/lib/date";
import {
  calendarDateForOperationalTime,
  operationalDayOfRecord,
} from "@/lib/logic/operational-day";
import { missingSeriesSlots, parseRule } from "@/lib/logic/recurrence";
import { resetMinuteOf } from "@/lib/logic/schedule";

/**
 * Recurring planner items are *materialised*: a series is one parent row
 * carrying the recurrence rule (the parent's own operational day is the
 * series' start date) plus one row per occurrence up to `HORIZON_DAYS` out.
 * Everything downstream (completion, drag & drop, day summaries, the heatmap)
 * then works on concrete rows instead of needing a second, virtual code path.
 *
 * ## Identity and idempotency
 *
 * Every generated occurrence records the operational day it was generated FOR
 * in `originalDate` — its *slot* in the series. Slots make regeneration
 * idempotent by construction:
 *
 *  * an edited occurrence still occupies its slot (`isException` detaches its
 *    fields, not its identity), so it is never duplicated;
 *  * a *moved* occurrence still occupies its original slot, so the vacated
 *    day is not refilled;
 *  * a deleted occurrence's slot is remembered in the parent's `skipDates`
 *    and never recreated;
 *  * "delete this and future" truncates the parent rule itself, so the
 *    removed tail simply stops being part of the pattern.
 *
 * Rows written before `originalDate` existed derive their slot from their
 * current date/time (`slotOfOccurrence`), which is identical for any row that
 * has not been moved across days.
 *
 * ## Bounds
 *
 * Generation is bounded twice: forward by `HORIZON_DAYS` past today (the
 * planner tops the horizon back up on every open — open-ended series stay
 * open-ended without unbounded rows), and backward by `BACKFILL_LIMIT_DAYS`
 * (a series anchored far in the past materialises at most a year of backlog;
 * the routine top-up never backfills at all).
 */
export const HORIZON_DAYS = 120;

/** How far into the past an explicit (re)materialisation may reach. */
export const BACKFILL_LIMIT_DAYS = 366;

interface OccurrenceSlotSource {
  date: string;
  startMinute: number | null;
  originalDate?: string | null;
}

/** The series slot a row occupies — its generated-for day, edits included. */
export function slotOfOccurrence(row: OccurrenceSlotSource, resetMinute: number): DayKey {
  return row.originalDate ?? operationalDayOfRecord(row, resetMinute);
}

const laterDay = (a: DayKey, b: DayKey): DayKey => (daysBetween(a, b) > 0 ? b : a);

async function resetMinuteFor(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dayResetMinute: true },
  });
  return resetMinuteOf({ dayResetMinute: user?.dayResetMinute ?? undefined });
}

/** The slice of a Prisma client this module needs — works inside $transaction. */
type Db = Pick<typeof prisma, "scheduleItem">;

interface SeriesParentRow {
  id: string;
  userId: string;
  title: string;
  notes: string | null;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  category: string;
  priority: string;
  habitId: string | null;
  /** A series scheduled from a task carries the link on every occurrence. */
  taskId: string | null;
  recurrenceRule: string | null;
  skipDates: string | null;
  originalDate?: string | null;
}

/**
 * Materialise every missing occurrence of one series inside `[from, to]`.
 * Idempotent: slots already represented by any row of the series (the parent
 * included) or recorded in `skipDates` are left alone. Returns the
 * operational days that were written, so callers can recompute summaries.
 */
export async function materializeSeriesWindow(
  db: Db,
  parent: SeriesParentRow,
  resetMinute: number,
  from: DayKey,
  to: DayKey,
  /** Pass the series' children when already loaded to avoid a per-series query. */
  preloadedChildren?: OccurrenceSlotSource[],
): Promise<DayKey[]> {
  const rule = parseRule(parent.recurrenceRule);
  if (!rule) return [];

  const anchor = slotOfOccurrence(parent, resetMinute);
  const children =
    preloadedChildren ??
    (await db.scheduleItem.findMany({
      where: { seriesId: parent.id },
      select: { date: true, startMinute: true, originalDate: true },
    }));

  const start = laterDay(shiftDay(anchor, 1), from);
  if (daysBetween(start, to) < 0) return [];

  const slots = missingSeriesSlots({
    rule,
    anchor,
    from: start,
    to,
    existingSlots: [anchor, ...children.map((child) => slotOfOccurrence(child, resetMinute))],
    skipDates: parent.skipDates,
  });
  if (slots.length === 0) return [];

  await db.scheduleItem.createMany({
    data: slots.map((slot) => ({
      userId: parent.userId,
      title: parent.title,
      notes: parent.notes,
      // The slot is an operational day; the stored calendar date is the real
      // date of the row's times (a 1:00 AM occurrence stores on the next
      // calendar date). Timestamps are never bent to fit the grouping.
      date: calendarDateForOperationalTime(slot, parent.startMinute, resetMinute),
      originalDate: slot,
      startMinute: parent.startMinute,
      endMinute: parent.endMinute,
      allDay: parent.allDay,
      category: parent.category,
      priority: parent.priority,
      status: "planned",
      habitId: parent.habitId,
      taskId: parent.taskId,
      seriesId: parent.id,
      sortOrder: 0,
    })),
  });
  return slots;
}

/**
 * Keep every materialised series topped up to the horizon. Cheap and
 * idempotent — the planner page calls it on every open. It only ever fills
 * slots from `referenceToday` forward: the routine top-up never backfills the
 * past, so occurrences deleted before `skipDates` existed stay gone.
 */
export async function extendSeriesFor(
  userId: string,
  referenceToday: DayKey = today(),
  resetMinute?: number,
): Promise<number> {
  const parents = await prisma.scheduleItem.findMany({
    where: { userId, recurrenceRule: { not: null }, seriesId: null },
  });
  if (parents.length === 0) return 0;

  const reset = resetMinute ?? (await resetMinuteFor(userId));
  const horizon = shiftDay(referenceToday, HORIZON_DAYS);

  // One query answers "which slots does each series already hold?" — the
  // per-parent lookup would be an N+1 paid on every planner open.
  const children = await prisma.scheduleItem.findMany({
    where: { userId, seriesId: { in: parents.map((parent) => parent.id) } },
    select: { seriesId: true, date: true, startMinute: true, originalDate: true },
  });
  const childrenBySeries = new Map<string, OccurrenceSlotSource[]>();
  for (const child of children) {
    const list = childrenBySeries.get(child.seriesId as string) ?? [];
    list.push(child);
    childrenBySeries.set(child.seriesId as string, list);
  }

  let created = 0;
  for (const parent of parents) {
    const slots = await materializeSeriesWindow(
      prisma,
      parent,
      reset,
      referenceToday,
      horizon,
      childrenBySeries.get(parent.id) ?? [],
    );
    created += slots.length;
  }

  return created;
}

/**
 * Materialise a series from its anchor forward — used when a series is
 * created or re-shaped ("this and all future"), where the user explicitly
 * asked for the pattern from that day on, past days included. Backfill is
 * bounded to `BACKFILL_LIMIT_DAYS` before today so a mistyped ancient start
 * date cannot write years of rows.
 */
export async function materializeSeriesFromAnchor(
  db: Db,
  parent: SeriesParentRow,
  resetMinute: number,
  referenceToday: DayKey = today(),
): Promise<DayKey[]> {
  const anchor = slotOfOccurrence(parent, resetMinute);
  const from = laterDay(shiftDay(anchor, 1), shiftDay(referenceToday, -BACKFILL_LIMIT_DAYS));
  // A series anchored beyond today's horizon (a semester starting next term)
  // still materialises its own first stretch — the horizon runs from the
  // anchor or today, whichever is later.
  const to = shiftDay(laterDay(anchor, referenceToday), HORIZON_DAYS);
  return materializeSeriesWindow(db, parent, resetMinute, from, to);
}
