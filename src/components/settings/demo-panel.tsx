"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionCard } from "@/components/shared/section-card";
import { formatNumber } from "@/lib/utils";
import {
  loadSampleDataAction,
  previewDemoRemovalAction,
  removeDemoDataAction,
  setOnboardingVisibilityAction,
} from "@/server/actions/demo";
import type { DemoRemovalPreview } from "@/server/demo";

const MODEL_LABELS: Record<string, string> = {
  ScheduleItem: "Planner items",
  ScheduleTemplate: "Routines",
  Habit: "Habits",
  HabitLog: "Habit logs",
  Meal: "Meals",
  MealEntry: "Meal entries",
  MealTemplate: "Meal templates",
  MealTemplateItem: "Meal template items",
  Workout: "Workouts",
  WorkoutSet: "Workout sets",
  WorkoutTemplate: "Workout templates",
  Goal: "Goals",
  GoalEntry: "Goal entries",
  ScheduleRule: "Schedules",
  ScheduleOverride: "Schedule overrides",
  HealthMetric: "Health metrics",
  JournalEntry: "Journal entries",
  Reminder: "Reminders",
  FavoriteItem: "Favourites",
  Tag: "Tags",
};

export function DemoPanel({
  demoLoaded,
  demoRecordCount,
  canLoad,
  checklistDismissed,
}: {
  demoLoaded: boolean;
  demoRecordCount: number;
  canLoad: boolean;
  checklistDismissed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [removal, setRemoval] = React.useState<DemoRemovalPreview | null>(null);

  async function load() {
    setBusy("load");
    try {
      const result = await loadSampleDataAction();
      if (result.ok) {
        toast.success("Sample data loaded");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  async function askRemove() {
    setBusy("preview");
    try {
      const result = await previewDemoRemovalAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRemoval(result.data);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRemove() {
    setBusy("remove");
    try {
      const result = await removeDemoDataAction();
      if (result.ok) {
        toast.success(`Removed ${formatNumber(result.data.removed)} sample records`, {
          description: "Your own records are untouched; every derived number was recalculated.",
        });
        setRemoval(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  async function showChecklist() {
    setBusy("checklist");
    try {
      await setOnboardingVisibilityAction(true);
      toast.success("Checklist restored on the dashboard");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionCard
      title="Sample data"
      icon={Sparkles}
      accent="text-amber-500"
      description="Demo records are tracked individually, so removing them can never touch your own"
    >
      <div className="space-y-3">
        {demoLoaded ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                Sample data is loaded
                <Badge variant="muted" className="text-[10px]">
                  {formatNumber(demoRecordCount)} records
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Removing it deletes exactly the registered demo records and recalculates scores,
                streaks, the calendar and insights.
              </p>
            </div>
            <Button variant="destructive" onClick={askRemove} disabled={busy !== null}>
              {busy === "preview" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Remove sample data
            </Button>
          </div>
        ) : canLoad ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Load ten weeks of demo history</p>
              <p className="text-xs text-muted-foreground">
                Every chart, streak and heatmap gets something to show. Removable again in one step.
              </p>
            </div>
            <Button onClick={load} disabled={busy !== null}>
              {busy === "load" && <Loader2 className="animate-spin" />}
              Load sample data
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No sample data is loaded. Loading it is only offered while the account is empty, so
            demo history can never mix into records you are already keeping.
          </p>
        )}

        {checklistDismissed && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              The getting-started checklist on the dashboard was dismissed.
            </p>
            <Button variant="outline" size="sm" onClick={showChecklist} disabled={busy !== null}>
              {busy === "checklist" && <Loader2 className="animate-spin" />}
              Show it again
            </Button>
          </div>
        )}
      </div>

      <Dialog open={removal !== null} onOpenChange={(open) => !open && setRemoval(null)}>
        <DialogContent className="max-w-md">
          {removal && (
            <>
              <DialogHeader>
                <DialogTitle>Remove the sample data?</DialogTitle>
                <DialogDescription>
                  Exactly the {formatNumber(removal.recordCount)} registered demo records are
                  deleted. Anything you created yourself stays.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap gap-1">
                {removal.byModel.map((entry) => (
                  <Badge key={entry.model} variant="muted" className="text-[10px]">
                    {MODEL_LABELS[entry.model] ?? entry.model} × {formatNumber(entry.count)}
                  </Badge>
                ))}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRemoval(null)} disabled={busy !== null}>
                  Keep it
                </Button>
                <Button variant="destructive" onClick={confirmRemove} disabled={busy !== null}>
                  {busy === "remove" && <Loader2 className="animate-spin" />}
                  Remove sample data
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
