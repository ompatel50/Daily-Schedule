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
import {
  BUDGETABLE_CATEGORIES,
  BUDGET_ALERT_THRESHOLDS,
  BUDGET_PERIODS,
  BUDGET_PERIOD_META,
  FINANCE_CATEGORY_META,
  type BudgetPeriod,
  type FinanceCategory,
} from "@/lib/enums";
import { saveBudget } from "@/server/actions/finance";

/** A budget as the page serialises it, progress included. */
export interface BudgetView {
  id: string;
  category: string;
  label: string;
  amount: number;
  period: string;
  /** Null when this budget has no threshold alert. */
  threshold: number | null;
  thresholdReached: boolean;
  spent: number;
  remaining: number;
  percent: number;
  over: boolean;
  /** The days the period currently covers, for the "resets" hint. */
  windowStart: string;
  windowEnd: string;
}

/** The sentinel the Select uses for "no alert" — Radix forbids an empty value. */
const NO_ALERT = "none";

export function BudgetDialog({
  open,
  onOpenChange,
  budget,
  takenCategories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: BudgetView | null;
  /** Categories that already have a budget — hidden when creating. */
  takenCategories: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(budget?.id);
  const [pending, startTransition] = React.useTransition();
  const [category, setCategory] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [period, setPeriod] = React.useState<BudgetPeriod>("monthly");
  const [threshold, setThreshold] = React.useState<string>(NO_ALERT);
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  const available = BUDGETABLE_CATEGORIES.filter(
    (value) => value === budget?.category || !takenCategories.includes(value),
  );

  React.useEffect(() => {
    if (!open) return;
    setCategory(budget?.category ?? "");
    setAmount(budget ? String(budget.amount) : "");
    setPeriod(budget?.period === "weekly" ? "weekly" : "monthly");
    setThreshold(budget?.threshold ? String(budget.threshold) : NO_ALERT);
    setErrors({});
  }, [open, budget]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!category) {
      setErrors({ category: ["Pick a category"] });
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setErrors({ amount: ["Enter a target above zero"] });
      return;
    }

    startTransition(async () => {
      const result = await saveBudget({
        id: budget?.id,
        category,
        amount: value,
        period,
        alertThresholdPercent: threshold === NO_ALERT ? null : Number(threshold),
      });
      if (result.ok) {
        toast.success(isEdit ? "Budget updated" : "Budget created");
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
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit budget" : "New budget"}</DialogTitle>
            <DialogDescription>
              A spending target for one category, measured over a month or a week. Income,
              transfers and balance adjustments never count against it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="budget-category">Category</Label>
              <Select value={category} onValueChange={setCategory} disabled={isEdit}>
                <SelectTrigger
                  id="budget-category"
                  aria-invalid={Boolean(errors.category)}
                  aria-describedby={errors.category ? "budget-category-error" : undefined}
                >
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((value) => (
                    <SelectItem key={value} value={value}>
                      {FINANCE_CATEGORY_META[value as FinanceCategory].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.category && (
                <p id="budget-category-error" className="text-xs text-destructive">
                  {errors.category[0]}
                </p>
              )}
              {isEdit && (
                <p className="text-xs text-muted-foreground">
                  The category is the budget&apos;s identity — delete and recreate to move it.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="budget-period">Period</Label>
              <Select
                value={period}
                onValueChange={(value) => setPeriod(value as BudgetPeriod)}
              >
                <SelectTrigger id="budget-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUDGET_PERIODS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {BUDGET_PERIOD_META[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {period === "weekly"
                  ? "Measured over your current week, and it resets when the week does."
                  : "Measured over the calendar month, and it resets on the 1st."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="budget-amount">
                {period === "weekly" ? "Weekly target" : "Monthly target"}
              </Label>
              <Input
                id="budget-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                autoFocus={isEdit}
                value={amount}
                aria-invalid={Boolean(errors.amount)}
                aria-describedby={errors.amount ? "budget-amount-error" : undefined}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="400.00"
              />
              {errors.amount && (
                <p id="budget-amount-error" className="text-xs text-destructive">
                  {errors.amount[0]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="budget-threshold">Warn me at</Label>
              <Select value={threshold} onValueChange={setThreshold}>
                <SelectTrigger id="budget-threshold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ALERT}>No alert</SelectItem>
                  {BUDGET_ALERT_THRESHOLDS.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value}% of the target
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Reminds once per {period === "weekly" ? "week" : "month"} when spending crosses
                that line — never twice for the same period.
              </p>
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
                {isEdit ? "Save changes" : "Create budget"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
