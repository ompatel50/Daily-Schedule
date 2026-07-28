"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ScheduleEditor,
  emptyScheduleDraft,
  type ScheduleDraft,
} from "@/components/shared/schedule-editor";
import { GOAL_DOMAINS } from "@/lib/enums";
import {
  GOAL_COMPARISONS,
  GOAL_COMPARISON_META,
  GOAL_SOURCES,
  GOAL_SOURCE_META,
  type GoalComparison,
  type GoalSource,
} from "@/lib/logic/goals";
import { titleCase } from "@/lib/utils";
import { saveGoalWithSchedule } from "@/server/actions/goals";

export interface GoalDraft {
  id?: string;
  label: string;
  description: string;
  domain: string;
  metric: string;
  target: number;
  targetMax: number | null;
  unit: string;
  direction: string;
  period: string;
  source: string;
  sourceRef: string | null;
  startDate: string;
  endDate: string | null;
  active: boolean;
  schedule: ScheduleDraft;
}

export function emptyGoalDraft(today: string): GoalDraft {
  return {
    label: "",
    description: "",
    domain: "health",
    metric: "",
    target: 1,
    targetMax: null,
    unit: "",
    direction: "gte",
    period: "daily",
    source: "manual",
    sourceRef: null,
    startDate: today,
    endDate: null,
    active: true,
    schedule: emptyScheduleDraft(),
  };
}

/**
 * `apply` decides what a schedule change does to history. The default is the
 * only one that cannot rewrite a score you already saw.
 */
const APPLY_OPTIONS = [
  { value: "forward", label: "From today onward", hint: "Past days keep the old schedule" },
  { value: "all", label: "Recalculate all history", hint: "Past scores and streaks may change" },
];

export function GoalDialog({
  open,
  onOpenChange,
  goal,
  weekStartsOn = 1,
  habits = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: GoalDraft | null;
  weekStartsOn?: 0 | 1;
  habits?: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<GoalDraft>(goal ?? emptyGoalDraft(todayValue()));
  const [apply, setApply] = React.useState("forward");
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
  const [pending, startTransition] = React.useTransition();
  const isEditing = Boolean(goal?.id);

  // Re-seed the form whenever a different goal is opened. Editing is explicit:
  // nothing is written until Save.
  React.useEffect(() => {
    if (open) {
      setDraft(goal ?? emptyGoalDraft(todayValue()));
      setApply("forward");
      setErrors({});
    }
  }, [open, goal]);

  const patch = (changes: Partial<GoalDraft>) => setDraft((current) => ({ ...current, ...changes }));
  const comparison = draft.direction as GoalComparison;
  const source = draft.source as GoalSource;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!draft.label.trim()) {
      setErrors({ label: ["Give the goal a name"] });
      return;
    }
    if (draft.schedule.mode === "weekdays" && draft.schedule.weekdays.length === 0) {
      setErrors({ weekdays: ["Pick at least one day"] });
      return;
    }

    startTransition(async () => {
      const result = await saveGoalWithSchedule({
        goal: {
          id: draft.id,
          domain: draft.domain,
          // The metric key is an internal identifier; derive it from the name
          // rather than making the user invent one.
          metric: draft.metric || slugify(draft.label),
          label: draft.label.trim(),
          description: draft.description.trim() || null,
          target: draft.target,
          targetMax: comparison === "range" ? draft.targetMax : null,
          unit: draft.unit,
          direction: draft.direction,
          period: draft.period,
          source: draft.source,
          sourceRef: draft.sourceRef,
          startDate: draft.startDate,
          endDate: draft.endDate,
          active: draft.active,
        },
        schedule: draft.schedule,
        apply: { mode: apply },
      });

      if (result.ok) {
        toast.success(isEditing ? "Goal updated" : "Goal created");
        onOpenChange(false);
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit goal" : "New goal"}</DialogTitle>
            <DialogDescription>
              Goals are filled in from your logged data wherever possible — pick a completion
              source and you never have to tick it by hand.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="goal-name">Name</Label>
                <Input
                  id="goal-name"
                  value={draft.label}
                  autoFocus
                  aria-invalid={Boolean(errors.label)}
                  aria-describedby={errors.label ? "goal-name-error" : undefined}
                  placeholder="Complete a workout"
                  onChange={(event) => patch({ label: event.target.value })}
                />
                {errors.label && (
                  <p id="goal-name-error" className="text-xs text-destructive">
                    {errors.label[0]}
                  </p>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="goal-description">Description (optional)</Label>
                <Textarea
                  id="goal-description"
                  rows={2}
                  value={draft.description}
                  onChange={(event) => patch({ description: event.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="goal-domain">Category</Label>
                <Select value={draft.domain} onValueChange={(value) => patch({ domain: value })}>
                  <SelectTrigger id="goal-domain">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOAL_DOMAINS.map((domain) => (
                      <SelectItem key={domain} value={domain}>
                        {titleCase(domain)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="goal-source">Completion source</Label>
                <Select
                  value={draft.source}
                  onValueChange={(value) => {
                    const meta = GOAL_SOURCE_META[value as GoalSource];
                    patch({
                      source: value,
                      unit: draft.unit || meta.unit,
                      direction: value === "habit" ? "boolean" : draft.direction,
                    });
                  }}
                >
                  <SelectTrigger id="goal-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOAL_SOURCES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {GOAL_SOURCE_META[option].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{GOAL_SOURCE_META[source].description}</p>
              </div>

              {source === "habit" && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="goal-habit">Linked habit</Label>
                  <Select
                    value={draft.sourceRef ?? ""}
                    onValueChange={(value) => patch({ sourceRef: value })}
                  >
                    <SelectTrigger id="goal-habit" aria-invalid={Boolean(errors.sourceRef)}>
                      <SelectValue placeholder="Choose a habit" />
                    </SelectTrigger>
                    <SelectContent>
                      {habits.map((habit) => (
                        <SelectItem key={habit.id} value={habit.id}>
                          {habit.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {habits.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Create a habit first, then link it here.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="goal-comparison">Comparison</Label>
                <Select
                  value={draft.direction}
                  onValueChange={(value) =>
                    patch({
                      direction: value,
                      targetMax: value === "range" ? (draft.targetMax ?? draft.target + 100) : null,
                    })
                  }
                >
                  <SelectTrigger id="goal-comparison">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOAL_COMPARISONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {GOAL_COMPARISON_META[option].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="goal-period">Measured over</Label>
                <Select value={draft.period} onValueChange={(value) => patch({ period: value })}>
                  <SelectTrigger id="goal-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Each day</SelectItem>
                    <SelectItem value="weekly">Each week</SelectItem>
                    <SelectItem value="monthly">Each month</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {comparison !== "boolean" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="goal-target">
                      {comparison === "range" ? "Minimum" : "Target"}
                    </Label>
                    <Input
                      id="goal-target"
                      type="number"
                      min={0}
                      step="any"
                      value={draft.target}
                      onChange={(event) => patch({ target: Number(event.target.value) })}
                    />
                  </div>

                  {comparison === "range" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="goal-target-max">Maximum</Label>
                      <Input
                        id="goal-target-max"
                        type="number"
                        min={0}
                        step="any"
                        value={draft.targetMax ?? 0}
                        aria-invalid={Boolean(errors.targetMax)}
                        onChange={(event) => patch({ targetMax: Number(event.target.value) })}
                      />
                      {errors.targetMax && (
                        <p className="text-xs text-destructive">{errors.targetMax[0]}</p>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="goal-unit">Unit</Label>
                    <Input
                      id="goal-unit"
                      value={draft.unit}
                      placeholder="g, kcal, min…"
                      onChange={(event) => patch({ unit: event.target.value })}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="space-y-3 rounded-lg border p-3">
              <p className="section-title">Schedule</p>
              <ScheduleEditor
                value={draft.schedule}
                onChange={(schedule) => patch({ schedule })}
                weekStartsOn={weekStartsOn}
                showDaypart={false}
                idPrefix="goal-schedule"
                errors={errors}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="goal-start">Start date</Label>
                <Input
                  id="goal-start"
                  type="date"
                  value={draft.startDate}
                  onChange={(event) => patch({ startDate: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="goal-end">End date (optional)</Label>
                <Input
                  id="goal-end"
                  type="date"
                  value={draft.endDate ?? ""}
                  onChange={(event) => patch({ endDate: event.target.value || null })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="goal-active">Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  A disabled goal stops applying but keeps all of its history.
                </p>
              </div>
              <Switch
                id="goal-active"
                checked={draft.active}
                onCheckedChange={(checked) => patch({ active: checked })}
              />
            </div>

            {isEditing && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <Label htmlFor="goal-apply">Apply schedule change</Label>
                <Select value={apply} onValueChange={setApply}>
                  <SelectTrigger id="goal-apply">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APPLY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {APPLY_OPTIONS.find((option) => option.value === apply)?.hint}
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {isEditing ? "Save changes" : "Create goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "custom_goal"
  );
}

function todayValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}
