"use client";

import * as React from "react";
import Link from "next/link";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEAT_CLASSES, heatLevel, type HeatLevel } from "@/lib/logic/scoring";
import { formatDay, isToday, weekdayOf } from "@/lib/date";
import { cn, formatNumber } from "@/lib/utils";
import { useUIStore } from "@/store/ui-store";

export interface HeatDay {
  date: string;
  score: number;
  /**
   * Opportunities that actually applied. Zero means the day had nothing to
   * miss, so `score` is meaningless there and must be treated as "open day"
   * rather than as a zero.
   */
  scoreApplicable: number;
  scoreCompleted: number;
  scoreMissed: number;
  scoreExcluded: number;
  plannedCount: number;
  completedCount: number;
  habitsDue: number;
  habitsDone: number;
  calories: number;
  workoutCount: number;
  workoutMinutes: number;
}

export type HeatFilter = "all" | "planner" | "habits" | "nutrition" | "workouts";

/**
 * GitHub-style heatmap over a rolling window. Filtering swaps which metric
 * drives the shade, so "how consistent have I been with X" is one click away.
 */
export function ConsistencyHeatmap({
  days,
  byDate,
  filter,
}: {
  days: string[];
  byDate: Record<string, HeatDay>;
  filter: HeatFilter;
}) {
  // The user's today (synced from the server) decides which square gets the
  // ring — not the host clock.
  const todayKey = useUIStore((state) => state.todayKey);
  // Pad the start so every column is a full Sunday→Saturday week.
  const padded = React.useMemo(() => {
    const lead = weekdayOf(days[0]);
    return [...Array.from({ length: lead }, () => null), ...days];
  }, [days]);

  const weeks: Array<Array<string | null>> = [];
  for (let index = 0; index < padded.length; index += 7) {
    weeks.push(padded.slice(index, index + 7));
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-1">
          {weeks.map((week, weekIndex) => (
            <div key={weekIndex} className="flex flex-col gap-1">
              {week.map((day, dayIndex) => {
                if (!day) return <div key={dayIndex} className="h-3.5 w-3.5" />;
                const summary = byDate[day];
                const { value, hasData } = metricFor(summary, filter);
                const level = heatLevel(value, hasData);

                return (
                  <Tooltip key={day}>
                    <TooltipTrigger asChild>
                      <Link
                        href={`/today?date=${day}`}
                        aria-label={
                          summary
                            ? `${formatDay(day, "EEEE, MMMM d, yyyy")} — score ${summary.score} of 100`
                            : `${formatDay(day, "EEEE, MMMM d, yyyy")} — nothing tracked`
                        }
                        className={cn(
                          "h-3.5 w-3.5 rounded-[3px] transition-transform hover:scale-125",
                          HEAT_CLASSES[level as HeatLevel],
                          isToday(day, todayKey) &&
                            "ring-1 ring-foreground ring-offset-1 ring-offset-background",
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{formatDay(day, "EEE, MMM d, yyyy")}</p>
                      {summary ? (
                        <div className="mt-1 space-y-0.5 text-muted-foreground">
                          <p>Score {summary.score}/100</p>
                          <p>
                            Planner {summary.completedCount}/{summary.plannedCount} · Habits{" "}
                            {summary.habitsDone}/{summary.habitsDue}
                          </p>
                          <p>
                            {formatNumber(summary.calories)} kcal · {summary.workoutMinutes} min
                            trained
                          </p>
                        </div>
                      ) : (
                        <p className="mt-1 text-muted-foreground">Nothing tracked</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        {([0, 1, 2, 3, 4] as HeatLevel[]).map((level) => (
          <span key={level} className={cn("h-3 w-3 rounded-[3px]", HEAT_CLASSES[level])} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/** Which 0–100 value should drive the shading for the active filter. */
function metricFor(summary: HeatDay | undefined, filter: HeatFilter): { value: number; hasData: boolean } {
  if (!summary) return { value: 0, hasData: false };

  switch (filter) {
    case "planner":
      return {
        value: summary.plannedCount > 0 ? (summary.completedCount / summary.plannedCount) * 100 : 0,
        hasData: summary.plannedCount > 0,
      };
    case "habits":
      return {
        value: summary.habitsDue > 0 ? (summary.habitsDone / summary.habitsDue) * 100 : 0,
        hasData: summary.habitsDue > 0,
      };
    case "nutrition":
      // Binary-ish: logging at all is the behaviour being reinforced.
      return { value: summary.calories > 0 ? 100 : 0, hasData: summary.calories > 0 };
    case "workouts":
      return {
        value: Math.min(100, (summary.workoutMinutes / 45) * 100),
        hasData: summary.workoutCount > 0,
      };
    default:
      // A day with nothing applicable has no score. Treating its 0 as data
      // would paint every rest day as a bad day.
      return { value: summary.score, hasData: summary.scoreApplicable > 0 };
  }
}
