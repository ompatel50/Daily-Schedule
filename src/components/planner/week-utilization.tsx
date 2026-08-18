"use client";

import * as React from "react";
import { Gauge } from "lucide-react";

import type { ScheduleRowItem } from "@/components/planner/schedule-row";
import { Progress } from "@/components/ui/progress";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatDuration } from "@/lib/date";
import { weekUtilization } from "@/lib/logic/utilization";
import { cn } from "@/lib/utils";

/**
 * The week's utilisation summary, under the week grid: planned vs free
 * waking time, per-category bars, and how much of the planned time is done.
 * Pure arithmetic over the rows the grid already renders — no extra fetch.
 */
export function WeekUtilization({
  items,
  dayStartHour,
  dayEndHour,
}: {
  items: ScheduleRowItem[];
  dayStartHour: number;
  dayEndHour: number;
}) {
  const summary = React.useMemo(
    () => weekUtilization(items, { dayStartHour, dayEndHour }),
    [items, dayStartHour, dayEndHour],
  );

  if (summary.totalPlannedMinutes === 0 && summary.untimedCount === 0) return null;

  const plannedShare =
    summary.availableMinutes > 0
      ? Math.min(1, summary.totalPlannedMinutes / summary.availableMinutes)
      : 0;

  return (
    <section
      aria-label="Week utilisation"
      className="rounded-lg border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Utilisation
        </h3>
        <p className="text-xs text-muted-foreground">
          {formatDuration(summary.totalPlannedMinutes)} planned of{" "}
          {formatDuration(summary.availableMinutes)} waking time ·{" "}
          {formatDuration(summary.freeMinutes)} free
          {summary.completionRatio !== null &&
            ` · ${Math.round(summary.completionRatio * 100)}% of it done`}
        </p>
      </div>

      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${Math.round(plannedShare * 100)}% of waking time planned`}
      >
        <div
          className="h-full rounded-full bg-primary/70"
          style={{ width: `${Math.round(plannedShare * 100)}%` }}
        />
      </div>

      {summary.rows.length > 0 && (
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {summary.rows.map((row) => {
            const meta =
              CATEGORY_META[row.category as ScheduleCategory] ?? CATEGORY_META.personal;
            const width =
              summary.totalPlannedMinutes > 0
                ? Math.max(4, Math.round((row.plannedMinutes / summary.totalPlannedMinutes) * 100))
                : 0;
            return (
              <li key={row.category} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("h-2 w-2 rounded-full", meta.dot)} aria-hidden="true" />
                    {meta.label}
                  </span>
                  <span className="tabular text-muted-foreground">
                    {formatDuration(row.plannedMinutes)}
                    {row.doneMinutes > 0 && ` · ${formatDuration(row.doneMinutes)} done`}
                  </span>
                </div>
                <Progress value={width} className="mt-0.5 h-1 bg-muted" indicatorClassName={meta.dot} />
              </li>
            );
          })}
        </ul>
      )}

      {summary.untimedCount > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {summary.untimedCount} all-day or untimed{" "}
          {summary.untimedCount === 1 ? "block isn't" : "blocks aren't"} counted in the hours.
        </p>
      )}
    </section>
  );
}
