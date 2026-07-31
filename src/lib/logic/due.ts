import { addDays, addMonths, addYears } from "date-fns";

import { daysBetween, fromDayKey, toDayKey, type DayKey } from "@/lib/date";

/**
 * Anchored recurring due dates — pure, shared by bills and repeating tasks.
 *
 * Distinct from `lib/logic/recurrence.ts` on purpose: the planner materialises
 * occurrence *rows* from a rule; a due date is a single moving pointer that
 * advances when the obligation is met. The two systems answer different
 * questions and neither should inherit the other's machinery.
 *
 * Every occurrence is generated from the ANCHOR (the first due date), never
 * from the previous occurrence. That is what keeps "monthly on the 31st" at
 * the month's end forever — advancing from a clamped Feb 28 would drift to the
 * 28th of every later month and never recover.
 */

/** How often something falls due. `every` multiplies the unit (every 2 weeks). */
export interface Cadence {
  unit: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  every: number;
}

function occurrenceAt(anchor: DayKey, cadence: Cadence, index: number): DayKey {
  const start = fromDayKey(anchor);
  const every = Math.max(1, Math.floor(cadence.every));
  switch (cadence.unit) {
    case "daily":
      return toDayKey(addDays(start, index * every));
    case "weekly":
      return toDayKey(addDays(start, index * every * 7));
    // date-fns clamps an out-of-range day-of-month to the month's last day,
    // and always from the anchor's own day — exactly the no-drift behaviour.
    case "monthly":
      return toDayKey(addMonths(start, index * every));
    case "quarterly":
      return toDayKey(addMonths(start, index * every * 3));
    case "yearly":
      return toDayKey(addYears(start, index * every));
  }
}

/**
 * The first occurrence of the cadence STRICTLY after `after`. When the anchor
 * itself is later than `after`, the anchor is the answer — the series has not
 * started yet.
 */
export function nextOccurrenceAfter(anchor: DayKey, cadence: Cadence, after: DayKey): DayKey {
  if (daysBetween(after, anchor) > 0) return anchor;

  // Estimate the occurrence index, then walk to the first one past `after`.
  // The estimate can be off by one around month-length clamping, so the walk
  // starts one below and moves up — never more than a few steps.
  const every = Math.max(1, Math.floor(cadence.every));
  const days = daysBetween(anchor, after);
  const perUnit =
    cadence.unit === "daily"
      ? every
      : cadence.unit === "weekly"
        ? every * 7
        : cadence.unit === "monthly"
          ? every * 28
          : cadence.unit === "quarterly"
            ? every * 89
            : every * 365;
  let index = Math.max(0, Math.floor(days / perUnit) - 1);
  let occurrence = occurrenceAt(anchor, cadence, index);
  while (daysBetween(after, occurrence) <= 0) {
    index += 1;
    occurrence = occurrenceAt(anchor, cadence, index);
  }
  return occurrence;
}

// --- due bucketing -----------------------------------------------------------

/** How many days ahead still counts as "due soon" across the app. */
export const DUE_SOON_DAYS = 7;

export type DueBucket = "overdue" | "today" | "soon" | "later";

/** Signed distance to the due date: negative = overdue by that many days. */
export function daysUntil(due: DayKey, today: DayKey): number {
  return daysBetween(today, due);
}

export function dueBucketOf(due: DayKey, today: DayKey, soonDays = DUE_SOON_DAYS): DueBucket {
  const distance = daysUntil(due, today);
  if (distance < 0) return "overdue";
  if (distance === 0) return "today";
  if (distance <= soonDays) return "soon";
  return "later";
}

export function isOverdue(due: DayKey, today: DayKey): boolean {
  return daysUntil(due, today) < 0;
}

/** "Due today", "3 days overdue", "Due in 5 days" — one wording everywhere. */
export function describeDueDistance(due: DayKey, today: DayKey): string {
  const distance = daysUntil(due, today);
  if (distance === 0) return "Due today";
  if (distance === 1) return "Due tomorrow";
  if (distance === -1) return "1 day overdue";
  if (distance < 0) return `${-distance} days overdue`;
  return `Due in ${distance} days`;
}
