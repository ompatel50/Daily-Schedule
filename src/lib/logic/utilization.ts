import { spanDurationMinutes } from "@/lib/logic/schedule-span";

/**
 * Weekly utilisation — how much of the waking week is planned, per category,
 * and how much of the planned time actually happened. Pure arithmetic over
 * blocks the caller already fetched; no new data source.
 *
 * Honest bounds, stated in the UI:
 *  * only TIMED blocks carry minutes — all-day blocks are counted but cannot
 *    be summed into hours;
 *  * skipped blocks are explicitly not happening and count nowhere;
 *  * "available" is the user's own waking window (day start → day end)
 *    across seven days, so "free" means free waking time, not free clock.
 */

export interface UtilizationBlock {
  category: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  status: string;
}

export interface UtilizationRow {
  category: string;
  plannedMinutes: number;
  doneMinutes: number;
  /** Timed blocks contributing to this row. */
  blocks: number;
}

export interface WeekUtilization {
  /** Per category, most-planned first. Categories without timed blocks are absent. */
  rows: UtilizationRow[];
  totalPlannedMinutes: number;
  totalDoneMinutes: number;
  /** Seven days of the user's waking window. */
  availableMinutes: number;
  freeMinutes: number;
  /** All-day / untimed blocks — listed, never summed into minutes. */
  untimedCount: number;
  /** Timed blocks already marked done, for the "of it done" fraction. */
  completionRatio: number | null;
}

export function weekUtilization(
  blocks: readonly UtilizationBlock[],
  options: { dayStartHour: number; dayEndHour: number },
): WeekUtilization {
  const byCategory = new Map<string, UtilizationRow>();
  let totalPlanned = 0;
  let totalDone = 0;
  let untimed = 0;

  for (const block of blocks) {
    if (block.status === "skipped") continue;
    const duration = block.allDay
      ? null
      : spanDurationMinutes(block.startMinute, block.endMinute);
    if (duration === null || duration <= 0) {
      untimed += 1;
      continue;
    }
    const row = byCategory.get(block.category) ?? {
      category: block.category,
      plannedMinutes: 0,
      doneMinutes: 0,
      blocks: 0,
    };
    row.plannedMinutes += duration;
    row.blocks += 1;
    totalPlanned += duration;
    if (block.status === "done") {
      row.doneMinutes += duration;
      totalDone += duration;
    }
    byCategory.set(block.category, row);
  }

  const wakingMinutes = Math.max(0, (options.dayEndHour - options.dayStartHour) * 60);
  const availableMinutes = wakingMinutes * 7;

  return {
    rows: [...byCategory.values()].sort(
      (a, b) => b.plannedMinutes - a.plannedMinutes || a.category.localeCompare(b.category),
    ),
    totalPlannedMinutes: totalPlanned,
    totalDoneMinutes: totalDone,
    availableMinutes,
    freeMinutes: Math.max(0, availableMinutes - totalPlanned),
    untimedCount: untimed,
    completionRatio: totalPlanned > 0 ? totalDone / totalPlanned : null,
  };
}
