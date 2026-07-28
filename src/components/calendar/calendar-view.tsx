"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarRange, Flame, TrendingUp } from "lucide-react";

import { ConsistencyHeatmap, type HeatDay, type HeatFilter } from "@/components/calendar/consistency-heatmap";
import { SectionCard } from "@/components/shared/section-card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDay, isSameMonth, isToday } from "@/lib/date";
import { cn, formatNumber } from "@/lib/utils";

const FILTERS: Array<{ value: HeatFilter; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "planner", label: "Planner" },
  { value: "habits", label: "Habits" },
  { value: "nutrition", label: "Nutrition" },
  { value: "workouts", label: "Workouts" },
];

export function CalendarView({
  windowDays,
  byDate,
  monthDays,
  monthAnchor,
  weekdayLabels,
  journalDates,
}: {
  windowDays: string[];
  byDate: Record<string, HeatDay>;
  monthDays: string[];
  monthAnchor: string;
  weekdayLabels: string[];
  journalDates: string[];
}) {
  const [filter, setFilter] = React.useState<HeatFilter>("all");
  const journalSet = React.useMemo(() => new Set(journalDates), [journalDates]);

  const streaks = React.useMemo(() => computeStreakRuns(windowDays, byDate), [windowDays, byDate]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Consistency"
        icon={Flame}
        accent="text-emerald-500"
        description={`${windowDays.length} days · click any square to open that day`}
        action={
          <Tabs value={filter} onValueChange={(value) => setFilter(value as HeatFilter)}>
            <TabsList className="h-8">
              {FILTERS.map((option) => (
                <TabsTrigger key={option.value} value={option.value} className="px-2.5 py-0.5 text-xs">
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      >
        <ConsistencyHeatmap days={windowDays} byDate={byDate} filter={filter} />

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Current streak" value={`${streaks.current}`} hint="days ≥ 50" />
          <Stat label="Longest streak" value={`${streaks.longest}`} hint="in this window" />
          <Stat label="Days tracked" value={`${streaks.tracked}`} hint={`of ${windowDays.length}`} />
          <Stat label="Perfect days" value={`${streaks.perfect}`} hint="score ≥ 85" />
        </div>
      </SectionCard>

      <SectionCard
        title={formatDay(monthAnchor, "MMMM yyyy")}
        icon={CalendarRange}
        accent="text-domain-planner"
        description="Day-by-day detail"
      >
        <div className="overflow-hidden rounded-lg border">
          <div className="grid grid-cols-7 border-b bg-muted/40">
            {weekdayLabels.map((label) => (
              <div
                key={label}
                className="px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {monthDays.map((day) => {
              const summary = byDate[day];
              const outside = !isSameMonth(day, monthAnchor);

              return (
                <Link
                  key={day}
                  href={`/today?date=${day}`}
                  className={cn(
                    "flex min-h-[86px] flex-col gap-1 border-b border-r p-1.5 transition-colors hover:bg-accent/40",
                    outside && "bg-muted/20 opacity-50",
                    isToday(day) && "bg-domain-planner/[0.06]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "tabular text-xs font-medium",
                        isToday(day) &&
                          "flex h-5 w-5 items-center justify-center rounded-full bg-domain-planner text-[10px] text-white",
                      )}
                    >
                      {formatDay(day, "d")}
                    </span>
                    {summary && summary.score > 0 && (
                      <span
                        className={cn(
                          "tabular rounded px-1 text-[10px] font-medium",
                          summary.score >= 85
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : summary.score >= 50
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {summary.score}
                      </span>
                    )}
                  </div>

                  {summary && (
                    <div className="space-y-0.5 text-[10px] text-muted-foreground">
                      {summary.plannedCount > 0 && (
                        <p className="tabular">
                          ✓ {summary.completedCount}/{summary.plannedCount}
                        </p>
                      )}
                      {summary.habitsDue > 0 && (
                        <p className="tabular">
                          ◎ {summary.habitsDone}/{summary.habitsDue}
                        </p>
                      )}
                      {summary.calories > 0 && (
                        <p className="tabular">{formatNumber(summary.calories)} kcal</p>
                      )}
                      {summary.workoutMinutes > 0 && (
                        <p className="tabular">{summary.workoutMinutes} min</p>
                      )}
                    </div>
                  )}

                  {journalSet.has(day) && (
                    <span className="mt-auto h-1 w-1 rounded-full bg-amber-500" title="Has a note" />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center gap-1.5">
        <TrendingUp className="h-3 w-3 text-muted-foreground" />
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
      <p className="tabular mt-1 text-lg font-semibold leading-none">{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Streak of days scoring at least 50, plus a few window-level counts. */
function computeStreakRuns(days: string[], byDate: Record<string, HeatDay>) {
  let longest = 0;
  let running = 0;
  let tracked = 0;
  let perfect = 0;

  for (const day of days) {
    const summary = byDate[day];
    if (summary && summary.score > 0) tracked += 1;
    if (summary && summary.score >= 85) perfect += 1;

    if (summary && summary.score >= 50) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  // Current streak walks back from the end of the window.
  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const summary = byDate[days[index]];
    if (summary && summary.score >= 50) current += 1;
    else if (index === days.length - 1) continue; // today may still be in progress
    else break;
  }

  return { longest, current, tracked, perfect };
}
