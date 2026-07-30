"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Copy, Dumbbell, Loader2, Pencil, Plus, Zap } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { WorkoutDialog, type WorkoutDraft } from "@/components/workouts/workout-dialog";
import { WORKOUT_TYPE_META, type WorkoutType } from "@/lib/enums";
import { formatDay, formatDuration, relativeDayLabel } from "@/lib/date";
import { useUIStore } from "@/store/ui-store";
import { formatPace, pacePerKm, totalVolume } from "@/lib/logic/workouts";
import { cn, formatNumber } from "@/lib/utils";
import { startSession } from "@/server/actions/session";

export interface WorkoutView extends WorkoutDraft {
  id: string;
  setCount: number;
}

export interface WorkoutTemplateView {
  id: string;
  name: string;
  type: string;
  durationMin: number;
  exerciseCount: number;
  useCount: number;
}

/** "Today · Jul 28", "Monday · Jul 27", or just "Jul 25" for older entries. */
function dateLabel(date: string, reference: string): string {
  const relative = relativeDayLabel(date, reference);
  const absolute = formatDay(date, "MMM d");
  return relative === absolute ? absolute : `${relative} · ${absolute}`;
}

export function WorkoutManager({
  date,
  workouts,
  templates,
  exerciseNames,
  activeSessionId = null,
}: {
  date: string;
  workouts: WorkoutView[];
  templates: WorkoutTemplateView[];
  exerciseNames: string[];
  /** Set while a session is open, so this surface stops offering to start one. */
  activeSessionId?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The user's today, synced from the server — never the host clock.
  const todayKey = useUIStore((state) => state.todayKey);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<WorkoutDraft | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  // `?new=1` (from the command palette) opens the logger straight away.
  React.useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditing(null);
      setDialogOpen(true);
    }
  }, [searchParams]);

  /**
   * Starting a template opens a **session** rather than writing a finished
   * workout. The old behaviour claimed every set was done the moment you
   * tapped it, which is only true if you were logging something already over.
   */
  function runTemplate(template: WorkoutTemplateView) {
    setBusy(template.id);
    startTransition(async () => {
      const result = await startSession({ date, templateId: template.id });
      setBusy(null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.resumed) {
        toast.info("You already have a session open", {
          description: "Finish or stop it before starting another.",
        });
      } else {
        toast.success(`Started ${template.name}`);
      }
      router.refresh();
    });
  }

  /** Repeat a past workout as a session — last time's numbers as targets. */
  function repeat(workout: WorkoutView) {
    setBusy(workout.id);
    startTransition(async () => {
      // The user's today from the synced store, not the host clock.
      const result = await startSession({ date: todayKey, fromWorkoutId: workout.id });
      setBusy(null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.resumed) {
        toast.info("You already have a session open");
      } else {
        toast.success(`Started ${workout.name} again`);
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus /> Log workout
        </Button>
      </div>

      {templates.length > 0 && (
        <SectionCard
          title="Templates"
          icon={Zap}
          accent="text-domain-workout"
          description={
            activeSessionId
              ? "Finish the session you have open before starting another"
              : "Starts a live session — tick sets off as you go"
          }
        >
          <div className="flex flex-wrap gap-2">
            {templates.map((template) => {
              const meta = WORKOUT_TYPE_META[template.type as WorkoutType] ?? WORKOUT_TYPE_META.custom;
              return (
                <div key={template.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{template.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {meta.label} · {formatDuration(template.durationMin)}
                      {template.exerciseCount > 0 ? ` · ${template.exerciseCount} exercises` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null || activeSessionId !== null}
                    onClick={() => runTemplate(template)}
                  >
                    {busy === template.id && <Loader2 className="animate-spin" />}
                    Start
                  </Button>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Workout history"
        icon={Dumbbell}
        accent="text-domain-workout"
        description={`${workouts.length} recent ${workouts.length === 1 ? "session" : "sessions"}`}
      >
        {workouts.length === 0 ? (
          <EmptyState
            icon={Dumbbell}
            title="No workouts logged"
            description="Log a session manually, or start from a template."
            action={
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus /> Log your first workout
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {workouts.map((workout) => {
              const meta = WORKOUT_TYPE_META[workout.type as WorkoutType] ?? WORKOUT_TYPE_META.custom;
              // Carry each set's real completion flag. Forcing `true` was
              // harmless while every logged set was complete by construction;
              // a session finished with sets left outstanding would now have
              // its volume over-reported by exactly the work not done.
              const volume = totalVolume(workout.sets);
              const pace =
                workout.distanceKm && workout.durationMin
                  ? pacePerKm(workout.distanceKm, workout.durationMin)
                  : null;

              return (
                <div key={workout.id} className="group rounded-lg border px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{workout.name}</span>
                    <Badge variant="outline" className={cn("text-[10px]", meta.chip)}>
                      {meta.label}
                    </Badge>
                    {workout.status !== "completed" && (
                      <Badge variant="muted" className="text-[10px]">
                        {workout.status}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {/* Avoid "Jul 25 · Jul 25" — relativeDayLabel already
                          falls back to the short date for older entries. */}
                      {dateLabel(workout.date, todayKey)}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Repeat today"
                      disabled={busy !== null}
                      onClick={() => repeat(workout)}
                    >
                      {busy === workout.id ? <Loader2 className="animate-spin" /> : <Copy />}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit workout"
                      onClick={() => {
                        setEditing(workout);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                  </div>

                  <p className="tabular mt-1 text-xs text-muted-foreground">
                    {formatDuration(workout.durationMin)}
                    {workout.caloriesBurned ? ` · ${formatNumber(workout.caloriesBurned)} kcal` : ""}
                    {workout.setCount > 0 ? ` · ${workout.setCount} sets` : ""}
                    {volume > 0 ? ` · ${formatNumber(volume)} kg volume` : ""}
                    {workout.distanceKm ? ` · ${formatNumber(workout.distanceKm, 2)} km` : ""}
                    {pace !== null ? ` · ${formatPace(pace)}` : ""}
                    {workout.avgHeartRate ? ` · ${workout.avgHeartRate} bpm` : ""}
                  </p>

                  {workout.notes && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{workout.notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <WorkoutDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workout={editing}
        defaultDate={date}
        exerciseNames={exerciseNames}
      />
    </div>
  );
}
