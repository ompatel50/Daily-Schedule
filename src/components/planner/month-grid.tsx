"use client";

import Link from "next/link";

import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatDay, isSameMonth, isToday, monthGridDays, weekdayLabelsFor } from "@/lib/date";
import { findConflicts } from "@/lib/logic/planner";
import { cn } from "@/lib/utils";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";

const MAX_VISIBLE = 3;

/** Month overview. Clicking a day deep-links to that day's planner view. */
export function MonthGrid({
  anchor,
  items,
  weekStartsOn = 1,
  todayKey,
}: {
  anchor: string;
  items: ScheduleRowItem[];
  weekStartsOn?: 0 | 1;
  /** "Today" in the user's timezone; see `DateNav`. */
  todayKey?: string;
}) {
  const days = monthGridDays(anchor, weekStartsOn);
  const byDay = new Map<string, ScheduleRowItem[]>();
  for (const item of items) {
    byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-7 border-b bg-muted/40">
        {weekdayLabelsFor(weekStartsOn).map((label) => (
          <div
            key={label}
            className="px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((day) => {
          const dayItems = (byDay.get(day) ?? []).sort((a, b) => {
            if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
            return (a.startMinute ?? 1e9) - (b.startMinute ?? 1e9);
          });
          const outside = !isSameMonth(day, anchor);
          const done = dayItems.filter((item) => item.status === "done").length;
          // Same `findConflicts` as the day list. Cells are too small for
          // names, so a dot with a label is the whole indicator.
          const pairs = findConflicts(dayItems).length;
          const pairLabel = `${pairs} overlapping ${pairs === 1 ? "pair" : "pairs"} of blocks`;

          return (
            <Link
              key={day}
              href={`/planner?date=${day}&view=day`}
              className={cn(
                "flex min-h-[104px] flex-col gap-1 border-b border-r p-1.5 transition-colors hover:bg-accent/40",
                outside && "bg-muted/20 opacity-55",
                isToday(day, todayKey) && "bg-domain-planner/[0.06]",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "tabular text-xs font-medium",
                    isToday(day, todayKey) &&
                      "flex h-5 w-5 items-center justify-center rounded-full bg-domain-planner text-[10px] text-white",
                  )}
                >
                  {formatDay(day, "d")}
                </span>
                <div className="flex items-center gap-1.5">
                  {pairs > 0 && (
                    <span title={pairLabel} className="flex items-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                      <span className="sr-only">{pairLabel}</span>
                    </span>
                  )}
                  {dayItems.length > 0 && (
                    <span className="tabular text-[10px] text-muted-foreground">
                      {done}/{dayItems.length}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-0.5">
                {dayItems.slice(0, MAX_VISIBLE).map((item) => {
                  const meta =
                    CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
                  return (
                    <div key={item.id} className="flex items-center gap-1">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
                      <span
                        className={cn(
                          "truncate text-[10px] leading-tight",
                          item.status === "done" && "line-through opacity-60",
                        )}
                      >
                        {item.title}
                      </span>
                    </div>
                  );
                })}
                {dayItems.length > MAX_VISIBLE && (
                  <p className="pl-2.5 text-[10px] text-muted-foreground">
                    +{dayItems.length - MAX_VISIBLE} more
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
