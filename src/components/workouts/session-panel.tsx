"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, Loader2, Plus, Square, Timer, Trash2, TrendingUp, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SectionCard } from "@/components/shared/section-card";
import {
  describeSetTarget,
  elapsedMinutes,
  formatRest,
  isSessionComplete,
  restSecAfterSet,
  restState,
  sessionBlocks,
  sessionProgress,
  setOutcome,
  type ProgressionSuggestion,
  type SessionExerciseBlock,
  type SessionSet,
} from "@/lib/logic/session";
import { formatDuration } from "@/lib/date";
import { totalVolume } from "@/lib/logic/workouts";
import { cn, formatNumber } from "@/lib/utils";
import {
  abandonSession,
  addSessionSet,
  applyProgression,
  completeSet,
  discardSession,
  finishSession,
  getSessionGuide,
  removeSessionSet,
  setExerciseRest,
  setSessionRest,
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

/** What `getSessionGuide` returns; empty until the fetch lands. */
interface SessionGuide {
  groups: Record<string, string>;
  suggestions: Record<string, ProgressionSuggestion & { date: string }>;
}

const EMPTY_GUIDE: SessionGuide = { groups: {}, suggestions: {} };

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

  // Groups and progression estimates. History and template only change when a
  // workout ends, so once per open session is enough.
  const [guide, setGuide] = React.useState<SessionGuide>(EMPTY_GUIDE);
  React.useEffect(() => {
    let cancelled = false;
    void getSessionGuide(session.id).then((result) => {
      if (!cancelled && result.ok) setGuide(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const progress = sessionProgress(session.sets);
  const blocks = sessionBlocks(session.sets, guide.groups);
  const elapsed = now ? elapsedMinutes(session.startedAt, null, now) : 0;
  // Group-aware: inside a superset round this is null, so no timer runs
  // between the round's exercises.
  const restSec = restSecAfterSet(
    progress.lastCompleted,
    session.sets,
    guide.groups,
    session.restSecDefault,
  );
  const rest = now
    ? restState(progress.lastCompleted?.completedAt ?? null, restSec, now)
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

  // Browser notification permission, read once on the client. `null` until
  // then also covers browsers without the API.
  const [alertsPermission, setAlertsPermission] =
    React.useState<NotificationPermission | null>(null);
  React.useEffect(() => {
    if ("Notification" in window) setAlertsPermission(Notification.permission);
  }, []);

  function enableAlerts() {
    if (!("Notification" in window)) return;
    void Notification.requestPermission().then((permission) => {
      setAlertsPermission(permission);
      if (permission === "granted") {
        toast.success("Rest alerts on", {
          description: "You'll get a notification when the timer ends.",
        });
      }
    });
  }

  /**
   * The rest-over cue. Edge-triggered off the derived timer: the refs remember
   * which set the running rest was counting from, never a countdown, so the
   * timer itself stays a pure function of the stamps. The cue only fires when
   * that same rest ran out — ticking a set mid-rest moves the timer to a new
   * set (or, in a superset, silences it for the round), and that is "back at
   * work", not "rest over". The in-app toast and the aria status always fire;
   * the browser notification only when permission was already granted —
   * asking for it happens solely through the explicit button above.
   */
  const restingForRef = React.useRef<string | null>(null);
  const lastCompletedRef = React.useRef(progress.lastCompleted);
  lastCompletedRef.current = progress.lastCompleted;
  const nextSetRef = React.useRef(progress.next);
  nextSetRef.current = progress.next;
  if (rest.resting) restingForRef.current = progress.lastCompleted?.id ?? null;
  const [restCue, setRestCue] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (rest.resting) return;
    const owner = restingForRef.current;
    restingForRef.current = null;
    if (owner === null || lastCompletedRef.current?.id !== owner) return;

    const next = nextSetRef.current;
    const body = next ? `Next: ${next.exercise}, set ${next.setNumber}` : "All sets are done";
    setRestCue(`Rest over. ${body}.`);
    toast.info("Rest over", { description: body });
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("Rest over", { body });
      } catch {
        // Some mobile browsers only notify via a service worker; the toast
        // above already carried the cue.
      }
    }
  }, [rest.resting]);

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

  const suggestionShown = blocks.some((block) =>
    block.exercises.some(
      (entry) => guide.suggestions[entry.exercise] && entry.done < entry.sets.length,
    ),
  );

  function renderExercise(entry: SessionExerciseBlock) {
    const tip = guide.suggestions[entry.exercise];
    const outstanding = entry.sets.filter((set) => !set.completed);
    const applied =
      tip?.targetWeightKg != null &&
      outstanding.length > 0 &&
      outstanding.every((set) => set.targetWeightKg === tip.targetWeightKg);

    return (
      <div key={entry.exercise} className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{entry.exercise}</p>
          <span className="flex shrink-0 items-center gap-1.5">
            <RestControl
              label={`Rest after ${entry.exercise}`}
              valueSec={entry.sets[0]?.restSec ?? null}
              offLabel="rest default"
              placeholderSec={session.restSecDefault}
              disabled={pending !== null}
              onSave={(value) =>
                run(`rest-${entry.exercise}`, () =>
                  setExerciseRest({
                    workoutId: session.id,
                    exercise: entry.exercise,
                    restSec: value,
                  }),
                )
              }
            />
            <span className="tabular text-xs text-muted-foreground">
              {entry.done}/{entry.sets.length}
            </span>
          </span>
        </div>

        {tip && outstanding.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">Estimate</span>
              {tip.kind === "increase" && tip.targetWeightKg !== null
                ? ` — try ${tip.targetWeightKg} kg: `
                : " — repeat last time: "}
              {tip.reason}
            </span>
            {tip.targetWeightKg !== null &&
              (applied ? (
                <span className="shrink-0">applied</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={pending !== null}
                  onClick={() =>
                    run(
                      `apply-${entry.exercise}`,
                      () =>
                        applyProgression({
                          workoutId: session.id,
                          exercise: entry.exercise,
                          targetWeightKg: tip.targetWeightKg!,
                        }),
                      "Targets updated",
                    )
                  }
                >
                  Apply {tip.targetWeightKg} kg
                </Button>
              ))}
          </div>
        )}

        {entry.sets.map((set, index) => (
          <SetRow
            // The target is part of the key so applying a progression estimate
            // remounts the row — its inputs are seeded from the target once,
            // and a new target must reach them.
            key={`${set.id}:${set.targetReps ?? ""}:${set.targetWeightKg ?? ""}`}
            set={set}
            index={index}
            isNext={progress.next?.id === set.id}
            pending={pending === set.id}
            disabled={pending !== null}
            onComplete={(values) => run(set.id, () => completeSet({ id: set.id, ...values }))}
            onUndo={() => run(set.id, () => uncompleteSet(set.id))}
            onRemove={() => run(set.id, () => removeSessionSet(set.id))}
          />
        ))}
      </div>
    );
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
        {/* Announces the rest-over cue to screen readers; visually the toast
            and the vanishing banner carry it. */}
        <p role="status" aria-live="polite" className="sr-only">
          {restCue}
        </p>

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

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Rest between sets</span>
          <span className="flex items-center gap-1.5">
            {alertsPermission === "default" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={enableAlerts}
              >
                <Bell className="h-3.5 w-3.5" /> Enable alerts
              </Button>
            )}
            <RestControl
              label="Default rest"
              valueSec={session.restSecDefault}
              offLabel="off"
              disabled={pending !== null}
              onSave={(value) => run("rest-default", () => setSessionRest(session.id, value))}
            />
          </span>
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

        {blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No sets yet — add the first exercise below.
          </p>
        ) : (
          <div className="space-y-4">
            {blocks.map((block) =>
              block.label ? (
                <div
                  key={`group-${block.group}`}
                  className="space-y-3 rounded-lg border border-dashed border-domain-workout/40 p-2.5"
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {block.label} · no rest inside a round — the timer starts after the
                    round&apos;s last exercise
                  </p>
                  {block.exercises.map(renderExercise)}
                </div>
              ) : (
                block.exercises.map(renderExercise)
              ),
            )}
          </div>
        )}

        {suggestionShown && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            Progression estimates come from your own logged history and can be wrong. They are not
            professional coaching, training or medical advice.
          </p>
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

/**
 * A rest length as a compact tap-to-edit control. Seconds in, because that is
 * what the schema stores; the resting display uses mm:ss like the timer.
 */
function RestControl({
  label,
  valueSec,
  offLabel,
  placeholderSec = null,
  disabled,
  onSave,
}: {
  label: string;
  valueSec: number | null;
  /** What to show when there is no own value ("off", or "rest default"). */
  offLabel: string;
  /** Editing hint when empty — the value the fallback would use. */
  placeholderSec?: number | null;
  disabled: boolean;
  onSave: (restSec: number | null) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  function commit() {
    setEditing(false);
    const value = draft.trim() === "" ? null : Number(draft);
    onSave(value !== null && Number.isFinite(value) && value > 0 ? Math.round(value) : null);
  }

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground"
        aria-label={`${label}: ${valueSec !== null ? formatRest(valueSec) : offLabel} — edit`}
        disabled={disabled}
        onClick={() => {
          setDraft(valueSec !== null ? String(valueSec) : "");
          setEditing(true);
        }}
      >
        <Timer className="h-3.5 w-3.5" />
        {valueSec !== null ? formatRest(valueSec) : offLabel}
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <Input
        type="number"
        min={0}
        max={3600}
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-7 w-20 text-xs"
        aria-label={`${label}, seconds`}
        placeholder={placeholderSec ? String(placeholderSec) : "sec"}
      />
      <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={commit}>
        Set
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Cancel editing ${label}`}
        onClick={() => setEditing(false)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </span>
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
