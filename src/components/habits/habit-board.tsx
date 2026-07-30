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
import { formatDay } from "@/lib/date";
import type { DayStatus } from "@/lib/logic/schedule";
import { cn } from "@/lib/utils";
import { cycleHabitLog } from "@/server/actions/habits";

export interface HabitBoardItem extends HabitDraft {
  id: string;
  timeOfDay: string;
  dueToday: boolean;
  flexibleToday: boolean;
  todayStatus: string | null;
  streak: number;
  longestStreak: number;
  streakUnit: "occurrences" | "weeks";
  /** Null when nothing was scheduled in the window — not the same as 0%. */
  completionRate: number | null;
  opportunities: number;
  weekDone: number;
  weekTarget: number;
  scheduleSummary: string;
  recentLogs: Array<{ date: string; status: string }>;
  /**
   * Resolved status per day, decided by the schedule engine on the server. The
   * strip renders this verbatim rather than re-deciding due-ness in the
   * browser, which is how the two used to disagree.
   */
  dayStates: Array<{ date: string; status: DayStatus; label: string }>;
}

const HISTORY_DAYS = 28;

/**
 * One class per resolved status. Completed and missed are the only two that
 * carry weight; everything neutral is deliberately quiet, and days that were
 * never scheduled are outlined rather than filled so a real miss stands out.
 */
const DOT_CLASSES: Record<DayStatus, string> = {
  completed: "bg-emerald-500",
  missed: "bg-red-500/60",
  skipped: "bg-amber-500/50",
  excused: "bg-sky-500/40",
  pending: "bg-muted ring-1 ring-inset ring-foreground/20",
  future: "border border-dashed border-muted-foreground/30 bg-transparent",
  rest: "bg-teal-500/20",
  not_scheduled: "border border-dashed border-muted bg-transparent",
  canceled: "border border-dashed border-muted bg-transparent",
  inactive: "border border-dashed border-muted bg-transparent",
};

/**
 * The habits page: each habit is a card with its streak, completion rate and a
 * 28-day dot strip you can click to backfill a missed day. Editing history
 * matters — people log habits a day late all the time.
 */
export function HabitBoard({
  habits,
  date: _date,
  weekStartsOn = 1,
}: {
  habits: HabitBoardItem[];
  date: string;
  weekStartsOn?: 0 | 1;
}) {
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

      <HabitDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        habit={editing}
        weekStartsOn={weekStartsOn}
      />
    </div>
  );
}

function HabitCard({
  habit,
  onToggle,
  onEdit,
}: {
  habit: HabitBoardItem;
  onToggle: (habitId: string, day: string) => void;
  onEdit: () => void;
}) {
  const days = habit.dayStates.slice(-HISTORY_DAYS);
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
          label={habit.flexibleToday ? "This week" : "90d rate"}
          value={
            habit.flexibleToday
              ? `${habit.weekDone}/${habit.weekTarget}`
              : habit.completionRate === null
                ? "—"
                : `${habit.completionRate}%`
          }
          hint={
            habit.flexibleToday
              ? undefined
              : habit.completionRate === null
                ? "nothing scheduled yet"
                : `${habit.opportunities} scheduled`
          }
          accent="text-domain-habit"
        />
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{habit.scheduleSummary}</span>
          <span>{days.length > 0 ? formatDay(days[days.length - 1].date, "MMM d") : ""}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {days.map((day) => {
            const label = `${formatDay(day.date, "EEE, MMM d")} · ${day.label}`;
            return (
              <button
                key={day.date}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onToggle(habit.id, day.date)}
                className={cn(
                  "h-4 w-4 rounded-[3px] transition-transform hover:scale-125",
                  DOT_CLASSES[day.status],
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
  hint,
}: {
  icon: typeof Flame;
  label: string;
  value: string;
  accent: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2 text-center" title={hint}>
      <Icon className={cn("mx-auto h-3.5 w-3.5", accent)} />
      <p className="tabular mt-1 text-sm font-semibold leading-none">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
