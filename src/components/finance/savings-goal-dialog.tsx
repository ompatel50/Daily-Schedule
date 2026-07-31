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
import { Textarea } from "@/components/ui/textarea";
import { saveSavingsGoal } from "@/server/actions/finance";

/** A savings goal as the page serialises it — plain fields only. */
export interface SavingsGoalView {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  targetDate: string | null;
  notes: string | null;
  /** 0–100, capped — an overfunded goal reads as complete, not 130%. */
  percent: number;
  remaining: number;
  complete: boolean;
}

interface GoalForm {
  name: string;
  targetAmount: string;
  currentAmount: string;
  targetDate: string;
  notes: string;
}

function blankGoal(): GoalForm {
  return { name: "", targetAmount: "", currentAmount: "0", targetDate: "", notes: "" };
}

function formFrom(goal: SavingsGoalView): GoalForm {
  return {
    name: goal.name,
    targetAmount: String(goal.targetAmount),
    currentAmount: String(goal.currentAmount),
    targetDate: goal.targetDate ?? "",
    notes: goal.notes ?? "",
  };
}

export function SavingsGoalDialog({
  open,
  onOpenChange,
  goal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: SavingsGoalView | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(goal?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<GoalForm>(goal ? formFrom(goal) : blankGoal());
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(goal ? formFrom(goal) : blankGoal());
    setErrors({});
  }, [open, goal]);

  function set<K extends keyof GoalForm>(key: K, value: GoalForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give the goal a name"] });
      return;
    }
    const targetAmount = Number(form.targetAmount);
    if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
      setErrors({ targetAmount: ["The target must be above zero"] });
      return;
    }
    const currentAmount = Number(form.currentAmount);
    if (!Number.isFinite(currentAmount) || currentAmount < 0) {
      setErrors({ currentAmount: ["Cannot be negative"] });
      return;
    }

    startTransition(async () => {
      const result = await saveSavingsGoal({
        id: goal?.id,
        name: form.name.trim(),
        targetAmount,
        currentAmount,
        targetDate: form.targetDate || null,
        notes: form.notes.trim() || null,
      });

      if (result.ok) {
        toast.success(isEdit ? "Goal updated" : "Goal created");
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
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit savings goal" : "New savings goal"}</DialogTitle>
            <DialogDescription>
              A target to chip away at — use the quick add on the row to record contributions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="goal-name">Name</Label>
              <Input
                id="goal-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "goal-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Emergency fund"
              />
              {errors.name && (
                <p id="goal-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="goal-target">Target amount</Label>
                <Input
                  id="goal-target"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={form.targetAmount}
                  aria-invalid={Boolean(errors.targetAmount)}
                  aria-describedby={errors.targetAmount ? "goal-target-error" : undefined}
                  onChange={(event) => set("targetAmount", event.target.value)}
                  placeholder="0.00"
                />
                {errors.targetAmount && (
                  <p id="goal-target-error" className="text-xs text-destructive">
                    {errors.targetAmount[0]}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="goal-current">Already saved</Label>
                <Input
                  id="goal-current"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={form.currentAmount}
                  aria-invalid={Boolean(errors.currentAmount)}
                  aria-describedby={errors.currentAmount ? "goal-current-error" : undefined}
                  onChange={(event) => set("currentAmount", event.target.value)}
                />
                {errors.currentAmount && (
                  <p id="goal-current-error" className="text-xs text-destructive">
                    {errors.currentAmount[0]}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="goal-date">Target date (optional)</Label>
              <Input
                id="goal-date"
                type="date"
                value={form.targetDate}
                onChange={(event) => set("targetDate", event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="goal-notes">Notes (optional)</Label>
              <Textarea
                id="goal-notes"
                rows={2}
                value={form.notes}
                onChange={(event) => set("notes", event.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : "Create goal"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
