"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  Circle,
  CircleDashed,
  Flame,
  Minus,
  Moon,
  TrendingUp,
} from "lucide-react";

import { ConsistencyHeatmap, type HeatDay, type HeatFilter } from "@/components/calendar/consistency-heatmap";
import { SectionCard } from "@/components/shared/section-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDay, isSameMonth } from "@/lib/date";
import {
  CALENDAR_STATE_META,
  calendarStateFor,
  type CalendarDayState,
} from "@/lib/logic/day-score";
import { cn, formatNumber } from "@/lib/utils";

/**
 * Day states are never signalled by colour alone. Each carries an icon, a
 * border treatment and a text label in its accessible name, so the calendar
 * reads correctly in greyscale and to a screen reader.
 */
const STATE_STYLES: Record<CalendarDayState, { cell: string; chip: string; icon: typeof Circle }> = {
  completed: {
    cell: "border-l-2 border-l-emerald-500 bg-emerald-500/[0.07]",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  partial: {
    cell: "border-l-2 border-l-amber-500 bg-amber-500/[0.05]",
    chip: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
    icon: CircleDashed,
  },
  missed: {
    cell: "border-l-2 border-l-rose-500 bg-rose-500/[0.05]",
    chip: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
    icon: AlertCircle,
  },
  rest: {
    cell: "border-l-2 border-l-teal-400/60 bg-teal-500/[0.04]",
    chip: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
    icon: Moon,
  },
  future: {
    cell: "border-l-2 border-l-dashed border-l-muted-foreground/30",
    chip: "bg-muted text-muted-foreground",
    icon: CalendarClock,
  },
  open: {
    cell: "",
    chip: "bg-muted text-muted-foreground",
    icon: Circle,
  },
  no_data: {
    cell: "",
    chip: "bg-muted/60 text-muted-foreground",
    icon: Minus,
  },
};

const LEGEND_ORDER: CalendarDayState[] = [
  "completed",
  "partial",
  "missed",
  "rest",
  "future",
  "open",
  "no_data",
];

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
  today,
  selected,
}: {
  windowDays: string[];
  byDate: Record<string, HeatDay>;
  monthDays: string[];
  monthAnchor: string;
  weekdayLabels: string[];
  journalDates: string[];
  /** Today in the user's configured timezone, resolved on the server. */
  today: string;
  /** The date whose detail panel is open, if any. */
  selected?: string;
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
            <TabsList className="h-auto flex-wrap justify-start sm:h-8 sm:flex-nowrap">
              {FILTERS.map((option) => (
                <TabsTrigger key={option.value} value={option.value} className="px-2.5 py-0.5 text-xs">
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {/* The heatmap renders outside the Tabs tree; mounted empty stubs
                keep every trigger's aria-controls valid. */}
            {FILTERS.map((option) => (
              <TabsContent key={option.value} value={option.value} forceMount hidden />
            ))}
          </Tabs>
        }
      >
        <ConsistencyHeatmap days={windowDays} byDate={byDate} filter={filter} />

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Current streak" value={`${streaks.current}`} hint="scored days ≥ 50" />
          <Stat label="Longest streak" value={`${streaks.longest}`} hint="in this window" />
          <Stat
            label="Scored days"
            value={`${streaks.tracked}`}
            hint={`of ${windowDays.length} · rest days excluded`}
          />
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
              const isFuture = day > today;
              const state = calendarStateFor({
                score: summary && summary.scoreApplicable > 0 ? summary.score : null,
                applicable: summary?.scoreApplicable ?? 0,
                completed: summary?.scoreCompleted ?? 0,
                isFuture,
                hasAnyRecord: Boolean(
                  summary &&
                    (summary.plannedCount > 0 ||
                      summary.calories > 0 ||
                      summary.workoutCount > 0 ||
                      summary.habitsDue > 0),
                ),
                isRestDay: (summary?.scoreExcluded ?? 0) > 0 && (summary?.scoreApplicable ?? 0) === 0,
              });
              const meta = CALENDAR_STATE_META[state];
              const style = STATE_STYLES[state];
              const StateIcon = style.icon;

              return (
                <Link
                  key={day}
                  href={`/calendar?date=${monthAnchor}&detail=${day}`}
                  scroll={false}
                  aria-label={`${formatDay(day, "EEEE, MMMM d")} — ${meta.label}${
                    summary && summary.scoreApplicable > 0
                      ? `, ${summary.scoreCompleted} of ${summary.scoreApplicable} met, score ${summary.score}`
                      : ""
                  }`}
                  aria-current={day === selected ? "true" : undefined}
                  className={cn(
                    "flex min-h-[86px] flex-col gap-1 border-b border-r p-1.5 transition-colors hover:bg-accent/40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    style.cell,
                    outside && "bg-muted/20",
                    day === today && "ring-1 ring-inset ring-domain-planner/40",
                    day === selected && "ring-2 ring-inset ring-domain-planner",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "tabular text-xs font-medium",
                        day === today &&
                          "flex h-5 w-5 items-center justify-center rounded-full bg-domain-planner text-[10px] text-white",
                      )}
                    >
                      {formatDay(day, "d")}
                    </span>
                    <span className="flex items-center gap-1">
                      <StateIcon
                        className="h-3 w-3 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {summary && summary.scoreApplicable > 0 && (
                        <span className={cn("tabular rounded px-1 text-[10px] font-medium", style.chip)}>
                          {summary.score}
                        </span>
                      )}
                    </span>
                  </div>

                  {summary && summary.scoreApplicable > 0 ? (
                    <div className="space-y-0.5 text-[10px] text-muted-foreground">
                      <p className="tabular">
                        {summary.scoreCompleted}/{summary.scoreApplicable} met
                      </p>
                      {summary.calories > 0 && (
                        <p className="tabular">{formatNumber(summary.calories)} kcal</p>
                      )}
                      {summary.workoutMinutes > 0 && (
                        <p className="tabular">{summary.workoutMinutes} min</p>
                      )}
                    </div>
                  ) : (
                    !outside && (
                      <p className="text-[10px] text-muted-foreground">{meta.label}</p>
                    )
                  )}

                  {journalSet.has(day) && (
                    <span
                      className="mt-auto h-1 w-1 rounded-full bg-amber-500"
                      title="Has a note"
                      aria-label="Has a note"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {LEGEND_ORDER.map((state) => {
            const meta = CALENDAR_STATE_META[state];
            const style = STATE_STYLES[state];
            const Icon = style.icon;
            return (
              <li key={state} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-[3px] border",
                    style.cell || "border-dashed",
                  )}
                  aria-hidden="true"
                >
                  <Icon className="h-2.5 w-2.5" />
                </span>
                <span>
                  <span className="font-medium text-foreground">{meta.label}</span> — {meta.description}
                </span>
              </li>
            );
          })}
        </ul>
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

/**
 * Streak of scored days reaching at least 50.
 *
 * Days with nothing applicable are skipped entirely rather than counted as
 * failures — a rest day neither extends nor breaks the run, exactly as it
 * behaves for habits and goals.
 */
function computeStreakRuns(days: string[], byDate: Record<string, HeatDay>) {
  let longest = 0;
  let running = 0;
  let tracked = 0;
  let perfect = 0;

  const scored = (day: string) => {
    const summary = byDate[day];
    return summary && summary.scoreApplicable > 0 ? summary : null;
  };

  for (const day of days) {
    const summary = scored(day);
    if (!summary) continue; // neutral: nothing was scheduled
    tracked += 1;
    if (summary.score >= 85) perfect += 1;

    if (summary.score >= 50) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  // Current streak walks back from the end of the window.
  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const summary = scored(days[index]);
    if (!summary) continue; // rest day — keeps walking back
    if (summary.score >= 50) current += 1;
    else if (index === days.length - 1) continue; // today may still be in progress
    else break;
  }

  return { longest, current, tracked, perfect };
}
