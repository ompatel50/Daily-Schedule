"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  INTENSITIES,
  WORKOUT_TYPES,
  WORKOUT_TYPE_META,
  type Intensity,
  type WorkoutType,
} from "@/lib/enums";
import { titleCase } from "@/lib/utils";
import { deleteWorkout, saveWorkout } from "@/server/actions/workouts";

export interface WorkoutSetDraft {
  exercise: string;
  reps: number | null;
  weightKg: number | null;
  durationSec: number | null;
  distanceM: number | null;
}

export interface WorkoutDraft {
  id?: string;
  date: string;
  time: string | null;
  name: string;
  type: string;
  durationMin: number;
  intensity: string;
  caloriesBurned: number | null;
  avgHeartRate: number | null;
  distanceKm: number | null;
  perceivedEffort: number | null;
  notes: string | null;
  status: string;
  sets: WorkoutSetDraft[];
}

const EMPTY_SET: WorkoutSetDraft = {
  exercise: "",
  reps: null,
  weightKg: null,
  durationSec: null,
  distanceM: null,
};

export function WorkoutDialog({
  open,
  onOpenChange,
  workout,
  defaultDate,
  exerciseNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workout?: WorkoutDraft | null;
  defaultDate: string;
  exerciseNames: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(workout?.id);
  const [pending, startTransition] = React.useTransition();

  const [form, setForm] = React.useState<WorkoutDraft>({
    date: defaultDate,
    time: null,
    name: "",
    type: "strength",
    durationMin: 45,
    intensity: "moderate",
    caloriesBurned: null,
    avgHeartRate: null,
    distanceKm: null,
    perceivedEffort: null,
    notes: null,
    status: "completed",
    sets: [],
  });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      workout ?? {
        date: defaultDate,
        time: null,
        name: "",
        type: "strength",
        durationMin: 45,
        intensity: "moderate",
        caloriesBurned: null,
        avgHeartRate: null,
        distanceKm: null,
        perceivedEffort: null,
        notes: null,
        status: "completed",
        sets: [],
      },
    );
  }, [open, workout, defaultDate]);

  function set<K extends keyof WorkoutDraft>(key: K, value: WorkoutDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const meta = WORKOUT_TYPE_META[form.type as WorkoutType] ?? WORKOUT_TYPE_META.custom;

  function updateSet(index: number, patch: Partial<WorkoutSetDraft>) {
    setForm((current) => ({
      ...current,
      sets: current.sets.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }

  function submit() {
    startTransition(async () => {
      const result = await saveWorkout({
        ...form,
        name: form.name.trim(),
        sets: form.sets
          .filter((row) => row.exercise.trim())
          .map((row, index) => ({
            exercise: row.exercise.trim(),
            setNumber: index + 1,
            reps: row.reps,
            weightKg: row.weightKg,
            durationSec: row.durationSec,
            distanceM: row.distanceM,
            completed: true,
          })),
        addToPlanner: true,
      });

      if (result.ok) {
        toast.success(isEdit ? "Workout updated" : "Workout logged");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove() {
    if (!workout?.id) return;
    startTransition(async () => {
      const result = await deleteWorkout(workout.id!);
      if (result.ok) {
        toast.success("Workout deleted");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit workout" : "Log a workout"}</DialogTitle>
          <DialogDescription>
            Calories are estimated from type, duration and intensity unless you enter a measured
            value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="w-name">Name</Label>
              <Input
                id="w-name"
                autoFocus
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Upper body push"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(value) => set("type", value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKOUT_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {WORKOUT_TYPE_META[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="w-date">Date</Label>
              <Input
                id="w-date"
                type="date"
                value={form.date}
                onChange={(event) => set("date", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-time">Time</Label>
              <Input
                id="w-time"
                type="time"
                value={form.time ?? ""}
                onChange={(event) => set("time", event.target.value || null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-duration">Minutes</Label>
              <Input
                id="w-duration"
                type="number"
                min={0}
                value={form.durationMin}
                onChange={(event) => set("durationMin", Number(event.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Intensity</Label>
              <Select
                value={form.intensity}
                onValueChange={(value) => set("intensity", value as Intensity)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTENSITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {titleCase(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="w-kcal">Calories</Label>
              <Input
                id="w-kcal"
                type="number"
                min={0}
                placeholder="auto"
                value={form.caloriesBurned ?? ""}
                onChange={(event) =>
                  set("caloriesBurned", event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-hr">Avg HR</Label>
              <Input
                id="w-hr"
                type="number"
                min={0}
                max={250}
                value={form.avgHeartRate ?? ""}
                onChange={(event) =>
                  set("avgHeartRate", event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
            {meta.tracksDistance && (
              <div className="space-y-1.5">
                <Label htmlFor="w-dist">Distance (km)</Label>
                <Input
                  id="w-dist"
                  type="number"
                  min={0}
                  step={0.01}
                  value={form.distanceKm ?? ""}
                  onChange={(event) =>
                    set("distanceKm", event.target.value === "" ? null : Number(event.target.value))
                  }
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="w-rpe">RPE (1-10)</Label>
              <Input
                id="w-rpe"
                type="number"
                min={1}
                max={10}
                value={form.perceivedEffort ?? ""}
                onChange={(event) =>
                  set("perceivedEffort", event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
          </div>

          {meta.tracksSets && (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label>Sets</Label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      sets: [
                        ...current.sets,
                        {
                          ...EMPTY_SET,
                          exercise: current.sets[current.sets.length - 1]?.exercise ?? "",
                        },
                      ],
                    }))
                  }
                >
                  <Plus /> Add set
                </Button>
              </div>

              {form.sets.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  No sets yet — add rows to track exercise, reps and weight.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_70px_80px_32px] gap-2 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>Exercise</span>
                    <span>Reps</span>
                    <span>Weight (kg)</span>
                    <span />
                  </div>
                  {form.sets.map((row, index) => (
                    <div key={index} className="grid grid-cols-[1fr_70px_80px_32px] gap-2">
                      <Input
                        list="exercise-names"
                        value={row.exercise}
                        onChange={(event) => updateSet(index, { exercise: event.target.value })}
                        placeholder="Bench press"
                        className="h-8"
                      />
                      <Input
                        type="number"
                        min={0}
                        value={row.reps ?? ""}
                        onChange={(event) =>
                          updateSet(index, {
                            reps: event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                        className="h-8"
                      />
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={row.weightKg ?? ""}
                        onChange={(event) =>
                          updateSet(index, {
                            weightKg: event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                        className="h-8"
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        aria-label="Remove set"
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            sets: current.sets.filter((_, i) => i !== index),
                          }))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <datalist id="exercise-names">
                {exerciseNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="w-notes">Notes</Label>
            <Textarea
              id="w-notes"
              value={form.notes ?? ""}
              onChange={(event) => set("notes", event.target.value || null)}
              placeholder="How did it feel?"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {isEdit ? (
            <Button variant="outline" size="sm" className="text-destructive" onClick={remove} disabled={pending}>
              <Trash2 /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !form.name.trim()}>
              {pending && <Loader2 className="animate-spin" />}
              {isEdit ? "Save changes" : "Log workout"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
