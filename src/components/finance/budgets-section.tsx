"use client";

import * as React from "react";
import { BellRing, Pencil, Plus, Target, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { RowMenu } from "@/components/finance/row-menu";
import type { BudgetView } from "@/components/finance/budget-dialog";
import { formatDay } from "@/lib/date";
import { formatMoney } from "@/lib/logic/finance";
import { cn } from "@/lib/utils";

/** Per-category monthly/weekly budgets, with spend progress and alerts. */
export function BudgetsSection({
  budgets,
  currency,
  onNew,
  onEdit,
  onDelete,
}: {
  budgets: BudgetView[];
  currency: string;
  onNew: () => void;
  onEdit: (budget: BudgetView) => void;
  onDelete: (budget: BudgetView) => void;
}) {
  return (
    <SectionCard
      title="Budgets"
      icon={Target}
      accent="text-domain-finance"
      description="Monthly or weekly targets per category"
      action={
        <Button size="sm" variant="ghost" onClick={onNew}>
          <Plus /> New budget
        </Button>
      }
    >
      {budgets.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No budgets yet"
          description="Set a monthly or weekly target for a category and watch spending against it."
          className="py-6"
        />
      ) : (
        <div className="space-y-2">
          {budgets.map((budget) => (
            <BudgetRow
              key={budget.id}
              budget={budget}
              currency={currency}
              onEdit={() => onEdit(budget)}
              onDelete={() => onDelete(budget)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function BudgetRow({
  budget,
  currency,
  onEdit,
  onDelete,
}: {
  budget: BudgetView;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const periodLabel = budget.period === "weekly" ? "Weekly" : "Monthly";
  return (
    <div className="rounded-lg border px-3 py-2.5">
      {/* The "Over by …" badge is wide; at phone widths it wraps under the label. */}
      <div className="flex flex-wrap items-center gap-1">
        <p className="min-w-0 flex-[1_1_8rem] truncate text-sm font-medium">{budget.label}</p>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <Badge variant="muted" className="text-[10px]">
            {periodLabel}
          </Badge>
          {budget.over ? (
            <Badge variant="outline" className="gap-1 border-red-500/30 text-[10px] text-red-700 dark:text-red-400">
              <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" />
              Over by {formatMoney(budget.spent - budget.effectiveAmount, currency)}
            </Badge>
          ) : budget.thresholdReached ? (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/30 text-[10px] text-amber-800 dark:text-amber-400"
            >
              <BellRing className="h-2.5 w-2.5" aria-hidden="true" />
              Past {budget.threshold}%
            </Badge>
          ) : null}
          <RowMenu
            label={`Actions for the ${budget.label} budget`}
            items={[{ label: "Edit", icon: Pencil, onClick: onEdit }]}
            onDelete={onDelete}
          />
        </div>
      </div>
      <Progress
        value={Math.min(100, budget.percent)}
        className="mt-2 h-1.5"
        indicatorClassName={
          budget.over ? "bg-red-500" : budget.thresholdReached ? "bg-amber-500" : "bg-domain-finance"
        }
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular">
          {formatMoney(budget.spent, currency)} / {formatMoney(budget.effectiveAmount, currency)}
        </span>
        <span className={cn("tabular", budget.over && "font-medium text-red-700 dark:text-red-400")}>
          {budget.over ? `${budget.percent}% spent` : `${formatMoney(budget.remaining, currency)} left`}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {budget.period === "weekly" ? "This week" : "This month"} ·{" "}
        {formatDay(budget.windowStart, "MMM d")} – {formatDay(budget.windowEnd, "MMM d")}
        {budget.carry > 0
          ? ` · includes ${formatMoney(budget.carry, currency)} rolled over`
          : budget.rollover
            ? " · rollover on"
            : ""}
        {budget.threshold !== null ? ` · alerts at ${budget.threshold}%` : ""}
      </p>
    </div>
  );
}
