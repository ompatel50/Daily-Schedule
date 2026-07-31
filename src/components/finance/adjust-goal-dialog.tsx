"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Minus, Plus } from "lucide-react";
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
import type { SavingsGoalView } from "@/components/finance/savings-goal-dialog";
import { formatMoney } from "@/lib/logic/finance";
import { adjustSavingsGoal } from "@/server/actions/finance";

/** Quick add-to / withdraw-from a savings goal without opening the full editor. */
export function AdjustGoalDialog({
  goal,
  currency,
  onClose,
}: {
  goal: SavingsGoalView | null;
  currency: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<"add" | "withdraw">("add");
  const [amount, setAmount] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!goal) return;
    setMode("add");
    setAmount("");
    setError(null);
  }, [goal]);

  if (!goal) return null;

  const numeric = Number(amount);
  const validAmount = Number.isFinite(numeric) && numeric > 0;
  const signed = mode === "add" ? numeric : -numeric;
  const next = validAmount ? goal.currentAmount + signed : null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!goal) return;
    setError(null);

    if (!validAmount) {
      setError("Enter an amount above zero");
      return;
    }
    if (next !== null && next < 0) {
      setError("That would take the goal below zero");
      return;
    }

    startTransition(async () => {
      const result = await adjustSavingsGoal({ id: goal.id, amount: signed });
      if (result.ok) {
        toast.success(
          mode === "add"
            ? `Added ${formatMoney(numeric, currency)} to ${goal.name}`
            : `Withdrew ${formatMoney(numeric, currency)} from ${goal.name}`,
        );
        onClose();
        router.refresh();
      } else {
        setError(result.error);
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{goal.name}</DialogTitle>
            <DialogDescription>
              Saved so far:{" "}
              <span className="tabular font-medium text-foreground">
                {formatMoney(goal.currentAmount, currency)}
              </span>{" "}
              of {formatMoney(goal.targetAmount, currency)}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1">
              <Button
                type="button"
                size="sm"
                variant={mode === "add" ? "default" : "ghost"}
                onClick={() => setMode("add")}
              >
                <Plus /> Add
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "withdraw" ? "default" : "ghost"}
                onClick={() => setMode("withdraw")}
              >
                <Minus /> Withdraw
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adjust-goal-amount">Amount</Label>
              <Input
                id="adjust-goal-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                autoFocus
                value={amount}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "adjust-goal-error" : undefined}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
              {error && (
                <p id="adjust-goal-error" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              {next !== null && next >= 0 && (
                <p className="text-xs text-muted-foreground">
                  New total: <span className="tabular">{formatMoney(next, currency)}</span>
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {mode === "add" ? "Add to goal" : "Withdraw"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
