"use client";

import * as React from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatMinute, formatTimeRange, isToday, nowMinute } from "@/lib/date";
import { DEFAULT_DAY_RESET_MINUTE, operationalSortMinute } from "@/lib/logic/operational-day";
import { conflictsByItem, summarizeConflicts } from "@/lib/logic/planner";
import { cn } from "@/lib/utils";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";

const PX_PER_MINUTE = 1.1;

/**
 * Proportional day timeline. Overlapping blocks are laid out side by side via a
 * simple greedy column packer — enough for a personal schedule without pulling
 * in a calendar library.
 *
 * Positions use the operational day's extended axis: an after-midnight block
 * renders past the 12:00 AM line at the bottom of the evening it belongs to,
 * while its labels keep the real wall-clock time.
 */
export function Timeline({
  date,
  items,
  startHour = 6,
  endHour = 22,
  dayResetMinute = DEFAULT_DAY_RESET_MINUTE,
  todayKey,
  onSelect,
}: {
  date: string;
  items: ScheduleRowItem[];
  startHour?: number;
  endHour?: number;
  /** The user's daily reset (minutes after midnight). */
  dayResetMinute?: number;
  /** "Today" in the user's timezone; see `DateNav`. */
  todayKey?: string;
  onSelect?: (item: ScheduleRowItem) => void;
}) {
  const [now, setNow] = React.useState<number | null>(null);

  // Client-only so SSR output stays deterministic. On the extended axis the
  // small hours read as minutes past 1440, so at 1:00 AM the marker sits at
  // the bottom of tonight's timeline instead of vanishing.
  React.useEffect(() => {
    if (!isToday(date, todayKey ?? undefined)) return;
    const tick = () => setNow(operationalSortMinute(nowMinute(), dayResetMinute));
    tick();
    const interval = setInterval(tick, 60_000);
    return () => clearInterval(interval);
  }, [date, todayKey, dayResetMinute]);

  const timed = React.useMemo(
    () =>
      items
        .filter((item) => !item.allDay && item.startMinute !== null)
        .map((item) => {
          // A block's minutes all live on one calendar date, so the whole
          // span shifts onto the extended axis together.
          const shift =
            dayResetMinute > 0 && (item.startMinute as number) < dayResetMinute ? 1440 : 0;
          const start = (item.startMinute as number) + shift;
          const end = Math.max(
            (item.endMinute ?? (item.startMinute as number) + 30) + shift,
            start + 20,
          );
          return { ...item, start, end };
        })
        .sort((a, b) => a.start - b.start),
    [items, dayResetMinute],
  );

  const bounds = React.useMemo(() => {
    let from = startHour * 60;
    let to = endHour * 60;
    for (const item of timed) {
      from = Math.min(from, Math.floor(item.start / 60) * 60);
      to = Math.max(to, Math.ceil(item.end / 60) * 60);
    }
    return { from, to };
  }, [timed, startHour, endHour]);

  const columns = React.useMemo(() => layoutColumns(timed), [timed]);

  // Same `findConflicts` as the day list's badges, fed the raw items — the
  // display minimums applied to `timed` above must not invent overlaps.
  const conflicts = React.useMemo(() => conflictsByItem(items), [items]);

  const height = (bounds.to - bounds.from) * PX_PER_MINUTE;
  const hours = Array.from(
    { length: Math.ceil((bounds.to - bounds.from) / 60) + 1 },
    (_, index) => bounds.from + index * 60,
  );

  if (timed.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="No timed blocks"
        description="Items with a start time appear here as a proportional timeline."
      />
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border bg-card/40">
      <div className="relative" style={{ height }}>
        {hours.map((minute) => (
          <div
            key={minute}
            className="absolute left-0 right-0 flex items-start"
            style={{ top: (minute - bounds.from) * PX_PER_MINUTE }}
          >
            <span className="tabular w-16 shrink-0 -translate-y-2 pl-3 text-[11px] text-muted-foreground">
              {formatMinute(minute % 1440)}
            </span>
            <div className="h-px flex-1 bg-border/70" />
          </div>
        ))}

        {now !== null && now >= bounds.from && now <= bounds.to && (
          <div
            className="absolute left-16 right-2 z-20 flex items-center"
            style={{ top: (now - bounds.from) * PX_PER_MINUTE }}
          >
            <span className="h-2 w-2 -translate-x-1 rounded-full bg-red-500" />
            <div className="h-px flex-1 bg-red-500/70" />
            {/* red-600, not 500: white 10px text needs ≥4.5:1 contrast. */}
            <span className="tabular ml-1 rounded bg-red-600 px-1 py-0.5 text-[10px] font-medium text-white">
              {formatMinute(now)}
            </span>
          </div>
        )}

        <div className="absolute inset-y-0 left-16 right-2">
          {timed.map((item) => {
            const layout = columns.get(item.id) ?? { column: 0, total: 1 };
            const meta = CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
            const width = 100 / layout.total;
            const clash = summarizeConflicts(conflicts.get(item.id) ?? []);

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect?.(item)}
                title={clash ? `Overlaps ${clash}` : undefined}
                className={cn(
                  "absolute overflow-hidden rounded-md border border-l-[3px] bg-card px-2 py-1 text-left shadow-sm transition-shadow hover:shadow-md",
                  meta.bar,
                  item.status === "done" && "opacity-90",
                  item.status === "skipped" && "opacity-90 grayscale",
                  clash && "border-amber-500/60 ring-1 ring-amber-500/40",
                )}
                style={{
                  top: (item.start - bounds.from) * PX_PER_MINUTE,
                  height: Math.max(22, (item.end - item.start) * PX_PER_MINUTE - 2),
                  left: `${layout.column * width}%`,
                  width: `calc(${width}% - 4px)`,
                }}
              >
                <p
                  className={cn(
                    "truncate text-xs font-medium leading-tight",
                    item.status === "done" && "line-through",
                  )}
                >
                  {clash && (
                    <TriangleAlert
                      className="mr-1 inline h-3 w-3 shrink-0 -translate-y-px text-amber-800 dark:text-amber-400"
                      aria-hidden
                    />
                  )}
                  {item.title}
                  {clash && <span className="sr-only">, overlaps {clash}</span>}
                </p>
                {(item.end - item.start) * PX_PER_MINUTE > 34 && (
                  <p className="tabular truncate text-[10px] text-muted-foreground">
                    {formatTimeRange(item.startMinute, item.endMinute, false)}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Greedy interval-graph colouring: assign each block the first column that is
 * free, and give every block in an overlapping cluster the same column count so
 * their widths line up.
 */
function layoutColumns(
  items: Array<{ id: string; start: number; end: number }>,
): Map<string, { column: number; total: number }> {
  const result = new Map<string, { column: number; total: number }>();
  let cluster: Array<{ id: string; start: number; end: number; column: number }> = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const total = Math.max(...cluster.map((item) => item.column)) + 1;
    for (const item of cluster) result.set(item.id, { column: item.column, total });
    cluster = [];
  };

  for (const item of items) {
    if (item.start >= clusterEnd) {
      flush();
      clusterEnd = item.end;
    } else {
      clusterEnd = Math.max(clusterEnd, item.end);
    }

    const taken = new Set(
      cluster.filter((other) => other.end > item.start).map((other) => other.column),
    );
    let column = 0;
    while (taken.has(column)) column += 1;

    cluster.push({ ...item, column });
  }

  flush();
  return result;
}
