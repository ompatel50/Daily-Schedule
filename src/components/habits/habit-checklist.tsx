"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Flame, MinusCircle, Repeat } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { TIME_OF_DAY_META, type TimeOfDay } from "@/lib/enums";
import { cn } from "@/lib/utils";
import { cycleHabitLog } from "@/server/actions/habits";
import type { HabitWithStats } from "@/server/queries";

export interface ChecklistHabit {
  id: string;
  name: string;
  timeOfDay: string;
  todayStatus: string | null;
  streak: number;
  frequency: string;
  weekDone: number;
  weekTarget: number;
}

/**
 * Today's habits, grouped by part of day. One click cycles
 * unlogged → done → skipped → unlogged, with optimistic feedback.
 */
export function HabitChecklist({
  habits,
  date,
}: {
  habits: Array<ChecklistHabit | HabitWithStats>;
  date: string;
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

  if (habits.length === 0) {
    return (
      <EmptyState
        icon={Repeat}
        title="No habits due"
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

            return (
              <button
                key={habit.id}
                type="button"
                onClick={() => cycle(habit)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  done
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : skipped
                      ? "border-dashed opacity-60"
                      : "hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                    done && "border-emerald-500 bg-emerald-500 text-white",
                    skipped && "border-dashed text-muted-foreground",
                  )}
                >
                  {done && <Check className="h-3 w-3" strokeWidth={3} />}
                  {skipped && <MinusCircle className="h-3 w-3" />}
                </span>

                <span className={cn("min-w-0 flex-1 truncate text-sm", done && "line-through opacity-70")}>
                  {habit.name}
                </span>

                {habit.frequency === "weekly" ? (
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {habit.weekDone}/{habit.weekTarget}
                  </span>
                ) : habit.streak > 0 ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-orange-500">
                    <Flame className="h-3 w-3" />
                    {habit.streak}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
