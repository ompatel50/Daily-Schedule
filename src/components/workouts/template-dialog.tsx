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
} from "@/lib/enums";
import { titleCase } from "@/lib/utils";
import { deleteWorkoutTemplate, saveWorkoutTemplate } from "@/server/actions/workouts";

export interface TemplateExerciseDraft {
  exercise: string;
  sets: number;
  reps: number | null;
  weightKg: number | null;
  restSec: number | null;
  /** Superset/circuit key; empty string means ungrouped. */
  group: string;
}

export interface TemplateDraft {
  id?: string;
  name: string;
  type: string;
  description: string | null;
  durationMin: number;
  intensity: string;
  exercises: TemplateExerciseDraft[];
}

/** Enough for two supersets and a circuit; more would not fit a session. */
const GROUP_KEYS = ["A", "B", "C", "D"] as const;
/** Radix Select cannot carry an empty value, so "ungrouped" needs a sentinel. */
const NO_GROUP = "none";

const EMPTY_EXERCISE: TemplateExerciseDraft = {
  exercise: "",
  sets: 3,
  reps: null,
  weightKg: null,
  restSec: null,
  group: "",
};

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  type: "strength",
  description: null,
  durationMin: 45,
  intensity: "moderate",
  exercises: [],
};

export function TemplateDialog({
  open,
  onOpenChange,
  template,
  exerciseNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: TemplateDraft | null;
  exerciseNames: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(template?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<TemplateDraft>(EMPTY_DRAFT);

  React.useEffect(() => {
    if (!open) return;
    setForm(template ?? EMPTY_DRAFT);
  }, [open, template]);

  function set<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateExercise(index: number, patch: Partial<TemplateExerciseDraft>) {
    setForm((current) => ({
      ...current,
      exercises: current.exercises.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }

  function submit() {
    startTransition(async () => {
      const result = await saveWorkoutTemplate({
        id: form.id,
        name: form.name.trim(),
        type: form.type,
        description: form.description,
        durationMin: form.durationMin,
        intensity: form.intensity,
        exercises: form.exercises
          .filter((row) => row.exercise.trim())
          .map((row) => ({
            exercise: row.exercise.trim(),
            sets: row.sets,
            reps: row.reps ?? undefined,
            weightKg: row.weightKg ?? undefined,
            restSec: row.restSec ?? undefined,
            group: row.group.trim() || undefined,
          })),
      });

      if (result.ok) {
        toast.success(isEdit ? "Template updated" : "Template saved");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove() {
    if (!template?.id) return;
    startTransition(async () => {
      const result = await deleteWorkoutTemplate(template.id!);
      if (result.ok) {
        toast.success("Template deleted");
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
          <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Starting the template opens a live session with these numbers as targets. Give two
            exercises the same group to run them as a superset: their sets alternate, and rest
            starts after each full round.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-duration">Minutes</Label>
              <Input
                id="t-duration"
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

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label>Exercises</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    exercises: [...current.exercises, { ...EMPTY_EXERCISE }],
                  }))
                }
              >
                <Plus /> Add exercise
              </Button>
            </div>

            {form.exercises.length === 0 ? (
              <p className="py-2 text-center text-xs text-muted-foreground">
                No exercises yet — each row becomes that many sets in the session.
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[1fr_52px_56px_72px_64px_84px_32px] gap-2 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span>Exercise</span>
                  <span>Sets</span>
                  <span>Reps</span>
                  <span>Kg</span>
                  <span>Rest s</span>
                  <span>Group</span>
                  <span />
                </div>
                {form.exercises.map((row, index) => (
                  <div key={index} className="grid grid-cols-[1fr_52px_56px_72px_64px_84px_32px] gap-2">
                    <Input
                      list="template-exercise-names"
                      value={row.exercise}
                      onChange={(event) => updateExercise(index, { exercise: event.target.value })}
                      placeholder="Bench press"
                      className="h-8"
                      aria-label={`Exercise ${index + 1}`}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      value={row.sets}
                      onChange={(event) =>
                        updateExercise(index, { sets: Number(event.target.value) || 1 })
                      }
                      className="h-8"
                      aria-label={`Sets for exercise ${index + 1}`}
                    />
                    <Input
                      type="number"
                      min={0}
                      value={row.reps ?? ""}
                      onChange={(event) =>
                        updateExercise(index, {
                          reps: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      className="h-8"
                      aria-label={`Reps for exercise ${index + 1}`}
                    />
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={row.weightKg ?? ""}
                      onChange={(event) =>
                        updateExercise(index, {
                          weightKg: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      className="h-8"
                      aria-label={`Weight for exercise ${index + 1}`}
                    />
                    <Input
                      type="number"
                      min={0}
                      max={3600}
                      value={row.restSec ?? ""}
                      onChange={(event) =>
                        updateExercise(index, {
                          restSec: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      className="h-8"
                      aria-label={`Rest seconds for exercise ${index + 1}`}
                    />
                    <Select
                      value={row.group || NO_GROUP}
                      onValueChange={(value) =>
                        updateExercise(index, { group: value === NO_GROUP ? "" : value })
                      }
                    >
                      <SelectTrigger
                        className="h-8"
                        aria-label={`Group for exercise ${index + 1}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_GROUP}>—</SelectItem>
                        {GROUP_KEYS.map((key) => (
                          <SelectItem key={key} value={key}>
                            {key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive"
                      aria-label={`Remove exercise ${index + 1}`}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          exercises: current.exercises.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <datalist id="template-exercise-names">
              {exerciseNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t-description">Description</Label>
            <Textarea
              id="t-description"
              value={form.description ?? ""}
              onChange={(event) => set("description", event.target.value || null)}
              placeholder="What is this template for?"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {isEdit ? (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={remove}
              disabled={pending}
            >
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
              {isEdit ? "Save changes" : "Save template"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
