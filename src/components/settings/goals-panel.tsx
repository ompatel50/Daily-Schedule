"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Pencil, Plus, Target, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/shared/section-card";
import { GoalDialog, emptyGoalDraft, type GoalDraft } from "@/components/settings/goal-dialog";
import { type ScheduleDraft } from "@/components/shared/schedule-editor";
import { GOAL_SOURCE_META, type GoalSource } from "@/lib/logic/goals";
import { cn, titleCase } from "@/lib/utils";
import { archiveGoal, deleteGoalPermanently, setGoalEnabled } from "@/server/actions/goals";

export interface GoalRow {
  id: string;
  domain: string;
  metric: string;
  label: string;
  description: string | null;
  target: number;
  targetMax: number | null;
  unit: string;
  direction: string;
  period: string;
  source: string;
  sourceRef: string | null;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  archived: boolean;
  scheduleSummary: string;
  targetSummary: string;
  schedule: ScheduleDraft;
}

/** One click for the goals almost everyone wants. */
const PRESETS: Array<{ label: string; draft: (today: string) => GoalDraft }> = [
  {
    label: "Workout Mon/Tue/Thu/Fri",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "Complete a workout",
      domain: "workout",
      metric: "workout_session",
      source: "workout_count",
      direction: "gte",
      target: 1,
      unit: "",
      schedule: { ...emptyGoalDraft(today).schedule, mode: "weekdays", weekdays: [1, 2, 4, 5] },
    }),
  },
  {
    label: "4 workouts per week",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "4 workouts per week",
      domain: "workout",
      metric: "workouts_per_week",
      source: "workout_count",
      direction: "gte",
      target: 4,
      period: "weekly",
      schedule: { ...emptyGoalDraft(today).schedule, mode: "times_per_week", timesPerWeek: 4 },
    }),
  },
  {
    label: "160 g protein daily",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "Eat 160 g of protein",
      domain: "nutrition",
      metric: "protein",
      source: "protein",
      direction: "gte",
      target: 160,
      unit: "g",
    }),
  },
  {
    label: "Under 2,200 kcal",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "Stay at or below 2,200 kcal",
      domain: "nutrition",
      metric: "calories",
      source: "calories",
      direction: "lte",
      target: 2200,
      unit: "kcal",
    }),
  },
  {
    label: "10,000 steps daily",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "Walk 10,000 steps",
      domain: "health",
      metric: "steps",
      source: "steps",
      direction: "gte",
      target: 10000,
    }),
  },
  {
    label: "8 h sleep Sun–Thu",
    draft: (today) => ({
      ...emptyGoalDraft(today),
      label: "Sleep at least 8 hours",
      domain: "health",
      metric: "sleep_hours",
      source: "sleep_hours",
      direction: "gte",
      target: 8,
      unit: "h",
      schedule: { ...emptyGoalDraft(today).schedule, mode: "weekdays", weekdays: [0, 1, 2, 3, 4] },
    }),
  },
];

export function GoalsPanel({
  goals,
  weekStartsOn = 1,
  habits = [],
  today,
}: {
  goals: GoalRow[];
  weekStartsOn?: 0 | 1;
  habits?: Array<{ id: string; name: string }>;
  today: string;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<GoalDraft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const active = goals.filter((goal) => !goal.archived);
  const archived = goals.filter((goal) => goal.archived);

  function openNew(draft?: GoalDraft) {
    setEditing(draft ?? emptyGoalDraft(today));
    setDialogOpen(true);
  }

  function openEdit(goal: GoalRow) {
    setEditing({
      id: goal.id,
      label: goal.label,
      description: goal.description ?? "",
      domain: goal.domain,
      metric: goal.metric,
      target: goal.target,
      targetMax: goal.targetMax,
      unit: goal.unit,
      direction: goal.direction,
      period: goal.period,
      source: goal.source,
      sourceRef: goal.sourceRef,
      startDate: goal.startDate ?? today,
      endDate: goal.endDate,
      active: goal.active,
      schedule: goal.schedule,
    });
    setDialogOpen(true);
  }

  function run(id: string, work: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    setPendingId(id);
    startTransition(async () => {
      const result = await work();
      setPendingId(null);
      if (result.ok) {
        toast.success(message);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  return (
    <SectionCard
      title="Goals"
      icon={Target}
      accent="text-emerald-500"
      description="What counts as a good day, and on which days it counts"
      action={
        <Button size="sm" onClick={() => openNew()}>
          <Plus /> New goal
        </Button>
      }
    >
      <div className="space-y-4">
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
            No goals yet. Add one below and progress starts showing up across the app.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((goal) => (
              <li
                key={goal.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5",
                  !goal.active && "opacity-60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{goal.label}</p>
                    <Badge variant="outline" className="text-[10px]">
                      {titleCase(goal.domain)}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px]", !goal.active && "line-through")}
                    >
                      {goal.active ? goal.scheduleSummary : "Disabled"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Target {goal.targetSummary}
                    {goal.period !== "daily" ? ` · per ${goal.period.replace("ly", "")}` : ""} ·{" "}
                    {GOAL_SOURCE_META[goal.source as GoalSource]?.label ?? "Manual"}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Switch
                    className="touch-target"
                    checked={goal.active}
                    aria-label={`${goal.active ? "Disable" : "Enable"} ${goal.label}`}
                    disabled={pending && pendingId === goal.id}
                    onCheckedChange={(checked) =>
                      run(
                        goal.id,
                        () => setGoalEnabled(goal.id, checked),
                        checked ? `${goal.label} enabled` : `${goal.label} disabled`,
                      )
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="touch-target"
                    aria-label={`Edit ${goal.label}`}
                    onClick={() => openEdit(goal)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="touch-target"
                    aria-label={`Archive ${goal.label}`}
                    disabled={pending && pendingId === goal.id}
                    onClick={() =>
                      run(goal.id, () => archiveGoal(goal.id, true), `${goal.label} archived`)
                    }
                  >
                    {pending && pendingId === goal.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Archive />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div>
          <p className="section-title mb-2">Add a common goal</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                size="sm"
                variant="outline"
                onClick={() => openNew(preset.draft(today))}
              >
                <Plus /> {preset.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Presets open the form pre-filled — nothing is saved until you confirm.
          </p>
        </div>

        {archived.length > 0 && (
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              Archived goals ({archived.length})
            </summary>
            <ul className="space-y-2 border-t p-3">
              {archived.map((goal) => (
                <li key={goal.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {goal.label}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending && pendingId === goal.id}
                    onClick={() =>
                      run(goal.id, () => archiveGoal(goal.id, false), `${goal.label} restored`)
                    }
                  >
                    <Undo2 /> Restore
                  </Button>
                  {confirmingDelete === goal.id ? (
                    <span className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending && pendingId === goal.id}
                        onClick={() => {
                          setConfirmingDelete(null);
                          run(
                            goal.id,
                            () => deleteGoalPermanently(goal.id),
                            `${goal.label} deleted`,
                          );
                        }}
                      >
                        Delete permanently
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="touch-target text-destructive"
                      aria-label={`Delete ${goal.label} permanently`}
                      onClick={() => setConfirmingDelete(goal.id)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="text-xs text-muted-foreground">
          Days a goal is not scheduled show as <strong>rest days</strong>. They never count as
          missed, never lower your day score, and never break a streak.
        </p>
      </div>

      <GoalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        goal={editing}
        weekStartsOn={weekStartsOn}
        habits={habits}
      />
    </SectionCard>
  );
}
