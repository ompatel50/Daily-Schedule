"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, Square, Timer, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SectionCard } from "@/components/shared/section-card";
import {
  describeSetTarget,
  elapsedMinutes,
  formatRest,
  groupByExercise,
  isSessionComplete,
  restState,
  sessionProgress,
  setOutcome,
  type SessionSet,
} from "@/lib/logic/session";
import { formatDuration } from "@/lib/date";
import { totalVolume } from "@/lib/logic/workouts";
import { cn, formatNumber } from "@/lib/utils";
import {
  abandonSession,
  addSessionSet,
  completeSet,
  discardSession,
  finishSession,
  removeSessionSet,
  uncompleteSet,
} from "@/server/actions/session";

export interface SessionView {
  id: string;
  name: string;
  date: string;
  startedAt: string | null;
  restSecDefault: number | null;
  sets: SessionSet[];
}

/**
 * The live session.
 *
 * Everything that ticks — elapsed time, the rest countdown — is derived from
 * stored stamps rather than held in state, so reloading the page or locking the
 * phone mid-set loses nothing. The only local state is what is being typed.
 */
export function SessionPanel({ session }: { session: SessionView }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  /**
   * One ticking clock for the whole panel.
   *
   * Starts as `null` so the server's HTML and the first client render agree —
   * seeding it with `new Date()` made the two disagree about the elapsed minutes
   * and tripped a hydration mismatch. The effect fills it in immediately after,
   * which is the same pattern the planner's timeline uses for its "now" line.
   */
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const handle = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(handle);
  }, []);

  const progress = sessionProgress(session.sets);
  const groups = groupByExercise(session.sets);
  const elapsed = now ? elapsedMinutes(session.startedAt, null, now) : 0;
  const rest = now
    ? restState(
        progress.lastCompleted?.completedAt ?? null,
        progress.lastCompleted?.restSec ?? session.restSecDefault,
        now,
      )
    : { remaining: 0, total: 0, resting: false };
  const volume = totalVolume(
    session.sets.map((set) => ({
      exercise: set.exercise,
      reps: set.reps,
      weightKg: set.weightKg,
      completed: set.completed,
    })),
  );
  const finishable = isSessionComplete(session.sets);
  const anythingDone = progress.done > 0;

  function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setPending(key);
    startTransition(async () => {
      const result = await fn();
      setPending(null);
      if (result.ok) {
        if (success) toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  return (
    <SectionCard
      title={session.name}
      icon={Timer}
      accent="text-domain-workout"
      description={`In progress · ${formatDuration(elapsed)} elapsed`}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {anythingDone ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                run(
                  "abandon",
                  () => abandonSession(session.id),
                  "Session stopped — what you did was kept",
                )
              }
            >
              <Square /> Stop early
            </Button>
          ) : (
            // Nothing was done, so throwing it away costs nothing. Once a set is
            // ticked this becomes "stop early" instead, and the server refuses
            // to discard.
            <Button
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => run("discard", () => discardSession(session.id), "Session discarded")}
            >
              <X /> Discard
            </Button>
          )}
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() =>
              run("finish", () => finishSession(session.id), "Workout logged")
            }
          >
            {pending === "finish" ? <Loader2 className="animate-spin" /> : <Check />}
            Finish
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {progress.done} of {progress.total} sets
            </span>
            <span className="tabular">
              {volume > 0 ? `${formatNumber(volume)} kg moved` : "nothing logged yet"}
            </span>
          </div>
          <Progress value={progress.percent} className="h-2" indicatorClassName="bg-domain-workout" />
        </div>

        {rest.resting && (
          <div className="flex items-center gap-3 rounded-lg border border-domain-workout/30 bg-domain-workout/5 px-3 py-2.5">
            <Timer className="h-4 w-4 shrink-0 text-domain-workout" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="tabular text-sm font-semibold">{formatRest(rest.remaining)}</p>
              <p className="text-xs text-muted-foreground">
                Resting after {progress.lastCompleted?.exercise}
              </p>
            </div>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-domain-workout transition-all"
                style={{ width: `${rest.total > 0 ? (rest.remaining / rest.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {finishable && (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
            Every set is done. Finish to log it.
          </p>
        )}

        {groups.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No sets yet — add the first exercise below.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.exercise} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{group.exercise}</p>
                  <span className="tabular text-xs text-muted-foreground">
                    {group.done}/{group.sets.length}
                  </span>
                </div>
                {group.sets.map((set, index) => (
                  <SetRow
                    key={set.id}
                    set={set}
                    index={index}
                    isNext={progress.next?.id === set.id}
                    pending={pending === set.id}
                    disabled={pending !== null}
                    onComplete={(values) =>
                      run(set.id, () => completeSet({ id: set.id, ...values }))
                    }
                    onUndo={() => run(set.id, () => uncompleteSet(set.id))}
                    onRemove={() => run(set.id, () => removeSessionSet(set.id))}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <AddSetForm
          workoutId={session.id}
          disabled={pending !== null}
          onAdded={() => router.refresh()}
        />
      </div>
    </SectionCard>
  );
}

const OUTCOME_TONE: Record<string, string> = {
  over: "text-emerald-600 dark:text-emerald-400",
  under: "text-amber-600 dark:text-amber-500",
  on_target: "text-muted-foreground",
  done: "text-muted-foreground",
  pending: "text-muted-foreground",
};

function SetRow({
  set,
  index,
  isNext,
  pending,
  disabled,
  onComplete,
  onUndo,
  onRemove,
}: {
  set: SessionSet;
  index: number;
  isNext: boolean;
  pending: boolean;
  disabled: boolean;
  onComplete: (values: { reps?: number | null; weightKg?: number | null }) => void;
  onUndo: () => void;
  onRemove: () => void;
}) {
  // Pre-filled with the target: the common case is doing what the plan said, so
  // ticking the box should not require typing anything.
  const [reps, setReps] = React.useState<string>(
    String(set.reps ?? set.targetReps ?? ""),
  );
  const [weight, setWeight] = React.useState<string>(
    String(set.weightKg ?? set.targetWeightKg ?? ""),
  );

  const outcome = setOutcome(set);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
        set.completed && "bg-muted/40 opacity-75",
        isNext && !set.completed && "border-domain-workout/50 bg-domain-workout/[0.04]",
        pending && "pointer-events-none opacity-60",
      )}
    >
      <span className="tabular w-6 shrink-0 text-xs text-muted-foreground">{index + 1}</span>

      {set.completed ? (
        <>
          <span className="tabular min-w-0 flex-1 text-sm">
            {set.reps ?? "—"} × {set.weightKg ?? "—"} kg
          </span>
          {outcome !== "done" && outcome !== "pending" && (
            <span className={cn("shrink-0 text-xs", OUTCOME_TONE[outcome])}>
              {outcome === "on_target"
                ? "on target"
                : outcome === "over"
                  ? "beat target"
                  : `target ${describeSetTarget(set)}`}
            </span>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Undo set" onClick={onUndo} disabled={disabled}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : (
        <>
          <Input
            type="number"
            min={0}
            value={reps}
            onChange={(event) => setReps(event.target.value)}
            className="h-8 w-16"
            aria-label={`Reps for set ${index + 1}`}
            placeholder={set.targetReps !== null ? String(set.targetReps) : "reps"}
          />
          <span className="text-xs text-muted-foreground">×</span>
          <Input
            type="number"
            min={0}
            step={0.5}
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            className="h-8 w-20"
            aria-label={`Weight for set ${index + 1}`}
            placeholder={set.targetWeightKg !== null ? String(set.targetWeightKg) : "kg"}
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            {describeSetTarget(set) !== "—" ? `target ${describeSetTarget(set)}` : ""}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Complete set ${index + 1}`}
              disabled={disabled}
              onClick={() =>
                onComplete({
                  reps: reps === "" ? null : Number(reps),
                  weightKg: weight === "" ? null : Number(weight),
                })
              }
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Done
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove set ${index + 1}`}
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function AddSetForm({
  workoutId,
  disabled,
  onAdded,
}: {
  workoutId: string;
  disabled: boolean;
  onAdded: () => void;
}) {
  const [exercise, setExercise] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  function submit() {
    const name = exercise.trim();
    if (!name) return;
    startTransition(async () => {
      const result = await addSessionSet({ workoutId, exercise: name });
      if (result.ok) {
        setExercise("");
        onAdded();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex items-end gap-2 border-t pt-3">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="add-exercise" className="text-xs">
          Add a set
        </Label>
        <Input
          id="add-exercise"
          value={exercise}
          onChange={(event) => setExercise(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          placeholder="Exercise name — or repeat one above"
          className="h-9"
        />
      </div>
      <Button size="sm" variant="outline" onClick={submit} disabled={disabled || pending || !exercise.trim()}>
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}
        Add
      </Button>
    </div>
  );
}
