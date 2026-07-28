"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Target, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/shared/section-card";
import { GOAL_DOMAINS, type GoalDomain } from "@/lib/enums";
import { titleCase } from "@/lib/utils";
import { deleteGoal, saveGoal } from "@/server/actions/health";

export interface GoalRow {
  id: string;
  domain: string;
  metric: string;
  label: string;
  target: number;
  unit: string;
  period: string;
  active: boolean;
}

/** Presets so the common goals are one click, not a form. */
const PRESETS: Array<Omit<GoalRow, "id" | "active">> = [
  { domain: "nutrition", metric: "calories", label: "Daily calories", target: 2200, unit: "kcal", period: "daily" },
  { domain: "nutrition", metric: "protein", label: "Daily protein", target: 160, unit: "g", period: "daily" },
  { domain: "workout", metric: "workouts_per_week", label: "Workouts per week", target: 4, unit: "", period: "weekly" },
  { domain: "health", metric: "steps", label: "Daily steps", target: 9000, unit: "", period: "daily" },
  { domain: "health", metric: "sleep_hours", label: "Sleep", target: 7.5, unit: "h", period: "daily" },
  { domain: "health", metric: "hydration_ml", label: "Hydration", target: 2500, unit: "ml", period: "daily" },
];

export function GoalsPanel({ goals }: { goals: GoalRow[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = React.useState<Record<string, number>>({});
  const [pending, startTransition] = React.useTransition();

  const existingMetrics = new Set(goals.map((goal) => goal.metric));
  const available = PRESETS.filter((preset) => !existingMetrics.has(preset.metric));

  const [custom, setCustom] = React.useState({
    domain: "health" as GoalDomain,
    metric: "",
    label: "",
    target: 0,
    unit: "",
    period: "daily",
  });

  function persist(goal: GoalRow, target: number) {
    startTransition(async () => {
      const result = await saveGoal({ ...goal, target, direction: "gte" });
      if (result.ok) {
        toast.success(`${goal.label} updated`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function addPreset(preset: (typeof PRESETS)[number]) {
    startTransition(async () => {
      const result = await saveGoal({ ...preset, direction: "gte", active: true });
      if (result.ok) {
        toast.success(`${preset.label} goal added`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function addCustom() {
    if (!custom.metric.trim() || !custom.label.trim()) {
      toast.error("Give the goal a key and a label");
      return;
    }
    startTransition(async () => {
      const result = await saveGoal({
        ...custom,
        metric: custom.metric.trim().toLowerCase().replace(/\s+/g, "_"),
        label: custom.label.trim(),
        direction: "gte",
        active: true,
      });
      if (result.ok) {
        toast.success("Goal added");
        setCustom({ domain: "health", metric: "", label: "", target: 0, unit: "", period: "daily" });
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <SectionCard
      title="Goals"
      icon={Target}
      accent="text-emerald-500"
      description="What progress bars across the app are measured against"
    >
      <div className="space-y-4">
        {goals.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
            No goals yet. Add one below and progress starts showing up everywhere.
          </p>
        ) : (
          <div className="space-y-2">
            {goals.map((goal) => (
              <div key={goal.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{goal.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {titleCase(goal.domain)} · {goal.period}
                    {goal.unit ? ` · ${goal.unit}` : ""}
                  </p>
                </div>
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  className="h-8 w-28"
                  value={drafts[goal.id] ?? goal.target}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [goal.id]: Number(event.target.value) }))
                  }
                  onBlur={() => {
                    const next = drafts[goal.id];
                    if (next !== undefined && next !== goal.target) persist(goal, next);
                  }}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive"
                  aria-label={`Delete ${goal.label}`}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await deleteGoal(goal.id);
                      if (result.ok) router.refresh();
                      else toast.error(result.error);
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        {available.length > 0 && (
          <div>
            <p className="section-title mb-2">Add a common goal</p>
            <div className="flex flex-wrap gap-2">
              {available.map((preset) => (
                <Button
                  key={preset.metric}
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => addPreset(preset)}
                >
                  <Plus /> {preset.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2 rounded-lg border p-3">
          <p className="section-title">Custom goal</p>
          <div className="grid gap-2 sm:grid-cols-5">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="goal-label">Label</Label>
              <Input
                id="goal-label"
                value={custom.label}
                placeholder="Meditation minutes"
                onChange={(event) => setCustom((c) => ({ ...c, label: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-metric">Key</Label>
              <Input
                id="goal-metric"
                value={custom.metric}
                placeholder="meditation"
                onChange={(event) => setCustom((c) => ({ ...c, metric: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-target">Target</Label>
              <Input
                id="goal-target"
                type="number"
                min={0}
                value={custom.target}
                onChange={(event) => setCustom((c) => ({ ...c, target: Number(event.target.value) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Domain</Label>
              <Select
                value={custom.domain}
                onValueChange={(value) => setCustom((c) => ({ ...c, domain: value as GoalDomain }))}
              >
                <SelectTrigger>
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
          </div>
          <Button size="sm" onClick={addCustom} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add goal
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
