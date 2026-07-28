"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Flame, Pencil, Plus, Repeat, Target, TrendingUp } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { HabitDialog, type HabitDraft } from "@/components/habits/habit-dialog";
import { HABIT_CATEGORY_META, TIME_OF_DAY_META, type HabitCategory, type TimeOfDay } from "@/lib/enums";
import { formatDay, lastNDays } from "@/lib/date";
import { isHabitDue } from "@/lib/logic/recurrence";
import { cn } from "@/lib/utils";
import { cycleHabitLog } from "@/server/actions/habits";

export interface HabitBoardItem extends HabitDraft {
  id: string;
  dueToday: boolean;
  todayStatus: string | null;
  streak: number;
  longestStreak: number;
  completionRate: number;
  weekDone: number;
  weekTarget: number;
  recentLogs: Array<{ date: string; status: string }>;
}

const HISTORY_DAYS = 28;

/**
 * The habits page: each habit is a card with its streak, completion rate and a
 * 28-day dot strip you can click to backfill a missed day. Editing history
 * matters — people log habits a day late all the time.
 */
export function HabitBoard({ habits, date }: { habits: HabitBoardItem[]; date: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<HabitDraft | null>(null);
  const [, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditing(null);
      setDialogOpen(true);
    }
  }, [searchParams]);

  const days = React.useMemo(() => lastNDays(HISTORY_DAYS, date), [date]);

  function toggle(habitId: string, day: string) {
    startTransition(async () => {
      const result = await cycleHabitLog(habitId, day);
      if (result.ok) router.refresh();
      else toast.error(result.error);
    });
  }

  const active = habits.filter((habit) => !habit.archived);
  const archived = habits.filter((habit) => habit.archived);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus /> New habit
        </Button>
      </div>

      {active.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No habits yet"
          description="Start with two or three. Consistency beats ambition."
          action={
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus /> Create a habit
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {active.map((habit) => (
            <HabitCard
              key={habit.id}
              habit={habit}
              days={days}
              onToggle={toggle}
              onEdit={() => {
                setEditing(habit);
                setDialogOpen(true);
              }}
            />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <SectionCard title="Archived" icon={Repeat} accent="text-muted-foreground">
          <div className="flex flex-wrap gap-2">
            {archived.map((habit) => (
              <button
                key={habit.id}
                type="button"
                onClick={() => {
                  setEditing(habit);
                  setDialogOpen(true);
                }}
                className="rounded-lg border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                {habit.name}
              </button>
            ))}
          </div>
        </SectionCard>
      )}

      <HabitDialog open={dialogOpen} onOpenChange={setDialogOpen} habit={editing} />
    </div>
  );
}

function HabitCard({
  habit,
  days,
  onToggle,
  onEdit,
}: {
  habit: HabitBoardItem;
  days: string[];
  onToggle: (habitId: string, day: string) => void;
  onEdit: () => void;
}) {
  const logsByDate = new Map(habit.recentLogs.map((log) => [log.date, log.status]));
  const categoryMeta =
    HABIT_CATEGORY_META[habit.category as HabitCategory] ?? HABIT_CATEGORY_META.personal;

  return (
    <div className="group rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{habit.name}</p>
            <Badge variant="outline" className={cn("text-[10px]", categoryMeta.chip)}>
              {categoryMeta.label}
            </Badge>
            {habit.timeOfDay !== "anytime" && (
              <Badge variant="muted" className="text-[10px]">
                {TIME_OF_DAY_META[habit.timeOfDay as TimeOfDay]?.label}
              </Badge>
            )}
          </div>
          {habit.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{habit.description}</p>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onEdit}
          aria-label={`Edit ${habit.name}`}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Pencil />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric icon={Flame} label="Streak" value={`${habit.streak}`} accent="text-orange-500" />
        <Metric icon={TrendingUp} label="Best" value={`${habit.longestStreak}`} accent="text-emerald-500" />
        <Metric
          icon={Target}
          label={habit.frequency === "weekly" ? "This week" : "90d rate"}
          value={
            habit.frequency === "weekly"
              ? `${habit.weekDone}/${habit.weekTarget}`
              : `${habit.completionRate}%`
          }
          accent="text-domain-habit"
        />
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Last {days.length} days</span>
          <span>{formatDay(days[days.length - 1], "MMM d")}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {days.map((day) => {
            const status = logsByDate.get(day);
            // A day the habit wasn't scheduled for isn't a miss — render it
            // faintly so "missed" actually stands out.
            const due = isHabitDue(
              {
                frequency: habit.frequency,
                weekdays: habit.weekdays,
                startDate: habit.startDate,
                endDate: null,
              },
              day,
            );

            return (
              <button
                key={day}
                type="button"
                title={`${formatDay(day, "EEE, MMM d")} · ${status ?? (due ? "missed" : "not scheduled")}`}
                onClick={() => onToggle(habit.id, day)}
                className={cn(
                  "h-4 w-4 rounded-[3px] transition-transform hover:scale-125",
                  status === "done"
                    ? "bg-emerald-500"
                    : status === "skipped"
                      ? "bg-amber-500/40"
                      : due
                        ? "bg-muted"
                        : "border border-dashed border-muted bg-transparent",
                )}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Flame;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2 text-center">
      <Icon className={cn("mx-auto h-3.5 w-3.5", accent)} />
      <p className="tabular mt-1 text-sm font-semibold leading-none">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
