"use client";

import * as React from "react";
import { Archive, Pencil, PiggyBank, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { RowMenu } from "@/components/finance/row-menu";
import type { SavingsGoalView } from "@/components/finance/savings-goal-dialog";
import { formatMoney } from "@/lib/logic/finance";

/** Savings goals: a target, progress toward it, and quick add-to-goal. */
export function SavingsGoalsSection({
  goals,
  currency,
  onNew,
  onAdjust,
  onEdit,
  onArchive,
  onDelete,
}: {
  goals: SavingsGoalView[];
  currency: string;
  onNew: () => void;
  onAdjust: (goal: SavingsGoalView) => void;
  onEdit: (goal: SavingsGoalView) => void;
  onArchive: (goal: SavingsGoalView) => void;
  onDelete: (goal: SavingsGoalView) => void;
}) {
  return (
    <SectionCard
      title="Savings goals"
      icon={PiggyBank}
      accent="text-domain-finance"
      action={
        <Button size="sm" variant="ghost" onClick={onNew}>
          <Plus /> New goal
        </Button>
      }
    >
      {goals.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No savings goals"
          description="Set a target and chip away at it."
          action={
            <Button size="sm" onClick={onNew}>
              <Plus /> Create a goal
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {goals.map((goal) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              currency={currency}
              onAdjust={() => onAdjust(goal)}
              onEdit={() => onEdit(goal)}
              onArchive={() => onArchive(goal)}
              onDelete={() => onDelete(goal)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function GoalRow({
  goal,
  currency,
  onAdjust,
  onEdit,
  onArchive,
  onDelete,
}: {
  goal: SavingsGoalView;
  currency: string;
  onAdjust: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1">
        <p className="min-w-0 flex-[1_1_8rem] truncate text-sm font-medium">{goal.name}</p>
        <div className="ml-auto flex items-center gap-1">
          {goal.complete && (
            <Badge variant="success" className="text-[10px]">
              Funded
            </Badge>
          )}
          <Button size="sm" variant="ghost" onClick={onAdjust}>
            <Plus /> Add
          </Button>
          <RowMenu
            label={`Actions for ${goal.name}`}
            items={[
              { label: "Edit", icon: Pencil, onClick: onEdit },
              { label: "Archive", icon: Archive, onClick: onArchive },
            ]}
            onDelete={onDelete}
          />
        </div>
      </div>
      <Progress value={goal.percent} className="mt-2 h-1.5" indicatorClassName="bg-domain-finance" />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular">
          {formatMoney(goal.currentAmount, currency)} / {formatMoney(goal.targetAmount, currency)}
        </span>
        <span className="tabular">
          {goal.complete ? "complete" : `${formatMoney(goal.remaining, currency)} to go`}
        </span>
      </div>
    </div>
  );
}
