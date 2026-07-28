"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Flame, MinusCircle, Moon, Repeat, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { TIME_OF_DAY_META, type TimeOfDay } from "@/lib/enums";
import type { DayStatus } from "@/lib/logic/schedule";
import { cn } from "@/lib/utils";
import { cycleHabitLog } from "@/server/actions/habits";

export interface ChecklistHabit {
  id: string;
  name: string;
  timeOfDay: string;
  todayStatus: string | null;
  status: DayStatus;
  statusLabel: string;
  streak: number;
  streakUnit?: "occurrences" | "weeks";
  dueToday: boolean;
  flexibleToday: boolean;
  weekDone: number;
  weekTarget: number;
  scheduleSummary: string;
}

/**
 * Today's habits, grouped by part of day. One click cycles
 * unlogged → done → skipped → unlogged, with optimistic feedback.
 *
 * Habits that are not scheduled today are not mixed in with the ones that are.
 * They sit in a collapsed, low-emphasis section, because a rest day is not a
 * pending task and should not look like one.
 */
export function HabitChecklist({
  habits,
  date,
  restingHabits = [],
}: {
  habits: ChecklistHabit[];
  date: string;
  /** Habits whose schedule does not place a requirement today. */
  restingHabits?: ChecklistHabit[];
}) {
  const router = useRouter();
  const [optimistic, setOptimistic] = React.useState<Record<string, string | null>>({});
  const [, startTransition] = React.useTransition();

  React.useEffect(() => setOptimistic({}), [habits]);

  function statusOf(habit: ChecklistHabit) {
    return habit.id in optimistic ? optimistic[habit.id] : habit.todayStatus;
  }

  function cycle(habit: ChecklistHabit) {
    const current = statusOf(habit);
    const next = current === null ? "done" : current === "done" ? "skipped" : null;
    setOptimistic((state) => ({ ...state, [habit.id]: next }));

    startTransition(async () => {
      const result = await cycleHabitLog(habit.id, date);
      if (!result.ok) {
        toast.error(result.error);
        setOptimistic((state) => {
          const { [habit.id]: _removed, ...rest } = state;
          return rest;
        });
      }
      router.refresh();
    });
  }

  if (habits.length === 0 && restingHabits.length === 0) {
    return (
      <EmptyState
        icon={Repeat}
        title="No habits yet"
        description="Create habits to build daily consistency."
        className="py-6"
      />
    );
  }

  const groups = new Map<string, ChecklistHabit[]>();
  for (const habit of habits) {
    const key = habit.timeOfDay || "anytime";
    groups.set(key, [...(groups.get(key) ?? []), habit]);
  }
  const ordered = Array.from(groups.entries()).sort(
    (a, b) =>
      (TIME_OF_DAY_META[a[0] as TimeOfDay]?.order ?? 9) -
      (TIME_OF_DAY_META[b[0] as TimeOfDay]?.order ?? 9),
  );

  return (
    <div className="space-y-3">
      {habits.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          Nothing scheduled today. That is a rest day, not a missed one.
        </p>
      )}

      {ordered.map(([timeOfDay, group]) => (
        <div key={timeOfDay} className="space-y-1">
          {ordered.length > 1 && (
            <p className="section-title text-[10px]">
              {TIME_OF_DAY_META[timeOfDay as TimeOfDay]?.label ?? timeOfDay}
            </p>
          )}
          {group.map((habit) => {
            const status = statusOf(habit);
            const done = status === "done";
            const skipped = status === "skipped";
            const excused = status === "excused";

            return (
              <button
                key={habit.id}
                type="button"
                onClick={() => cycle(habit)}
                aria-pressed={done}
                aria-label={`${habit.name} — ${done ? "completed" : habit.statusLabel}`}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  done
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : skipped || excused
                      ? "border-dashed opacity-60"
                      : "hover:bg-accent/50",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                    done && "border-emerald-500 bg-emerald-500 text-white",
                    (skipped || excused) && "border-dashed text-muted-foreground",
                  )}
                >
                  {done && <Check className="h-3 w-3" strokeWidth={3} />}
                  {skipped && <MinusCircle className="h-3 w-3" />}
                  {excused && <ShieldCheck className="h-3 w-3" />}
                </span>

                <span
                  className={cn("min-w-0 flex-1 truncate text-sm", done && "line-through opacity-70")}
                >
                  {habit.name}
                </span>

                {habit.flexibleToday ? (
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {habit.weekDone}/{habit.weekTarget} this week
                  </span>
                ) : habit.streak > 0 ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-orange-500">
                    <Flame className="h-3 w-3" aria-hidden="true" />
                    {habit.streak}
                    <span className="sr-only">
                      {habit.streakUnit === "weeks" ? " week streak" : " in a row"}
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}

      {restingHabits.length > 0 && (
        <details className="rounded-lg border border-dashed">
          <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground">
            <Moon className="mr-1 inline h-3 w-3" aria-hidden="true" />
            Not scheduled today ({restingHabits.length})
          </summary>
          <ul className="space-y-1 border-t px-2.5 py-2">
            {restingHabits.map((habit) => (
              <li
                key={habit.id}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="truncate">{habit.name}</span>
                <span className="shrink-0">{habit.scheduleSummary}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
