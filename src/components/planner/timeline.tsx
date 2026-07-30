"use client";

import * as React from "react";
import { CalendarClock } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatMinute, formatTimeRange, isToday, nowMinute } from "@/lib/date";
import { cn } from "@/lib/utils";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";

const PX_PER_MINUTE = 1.1;

/**
 * Proportional day timeline. Overlapping blocks are laid out side by side via a
 * simple greedy column packer — enough for a personal schedule without pulling
 * in a calendar library.
 */
export function Timeline({
  date,
  items,
  startHour = 6,
  endHour = 22,
  todayKey,
  onSelect,
}: {
  date: string;
  items: ScheduleRowItem[];
  startHour?: number;
  endHour?: number;
  /** "Today" in the user's timezone; see `DateNav`. */
  todayKey?: string;
  onSelect?: (item: ScheduleRowItem) => void;
}) {
  const [now, setNow] = React.useState<number | null>(null);

  // Client-only so SSR output stays deterministic.
  React.useEffect(() => {
    if (!isToday(date, todayKey ?? undefined)) return;
    setNow(nowMinute());
    const interval = setInterval(() => setNow(nowMinute()), 60_000);
    return () => clearInterval(interval);
  }, [date, todayKey]);

  const timed = React.useMemo(
    () =>
      items
        .filter((item) => !item.allDay && item.startMinute !== null)
        .map((item) => ({
          ...item,
          start: item.startMinute as number,
          end: Math.max((item.endMinute ?? item.startMinute! + 30), item.startMinute! + 20),
        }))
        .sort((a, b) => a.start - b.start),
    [items],
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
            <span className="tabular ml-1 rounded bg-red-500 px-1 py-0.5 text-[10px] font-medium text-white">
              {formatMinute(now)}
            </span>
          </div>
        )}

        <div className="absolute inset-y-0 left-16 right-2">
          {timed.map((item) => {
            const layout = columns.get(item.id) ?? { column: 0, total: 1 };
            const meta = CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
            const width = 100 / layout.total;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect?.(item)}
                className={cn(
                  "absolute overflow-hidden rounded-md border border-l-[3px] bg-card px-2 py-1 text-left shadow-sm transition-shadow hover:shadow-md",
                  meta.bar,
                  item.status === "done" && "opacity-90",
                  item.status === "skipped" && "opacity-90 grayscale",
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
                  {item.title}
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
