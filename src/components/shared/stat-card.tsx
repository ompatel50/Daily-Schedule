import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  accent?: string;
  /** 0–100; renders a progress bar when provided. */
  progress?: number;
  progressClassName?: string;
  /** Signed percentage change vs. the previous period. */
  delta?: number;
  /** When lower is better (e.g. resting HR), flip the delta colouring. */
  deltaInverted?: boolean;
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = "text-muted-foreground",
  progress,
  progressClassName,
  delta,
  deltaInverted,
}: StatCardProps) {
  const good = delta === undefined ? null : deltaInverted ? delta < 0 : delta > 0;
  const DeltaIcon = delta === undefined || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className={cn("h-4 w-4 shrink-0", accent)} />}
      </div>

      <p className="tabular mt-2 text-2xl font-semibold leading-none">{value}</p>

      <div className="mt-2 flex min-h-[18px] items-center gap-2">
        {delta !== undefined && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-medium",
              delta === 0
                ? "text-muted-foreground"
                : good
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400",
            )}
          >
            <DeltaIcon className="h-3 w-3" />
            {Math.abs(delta)}%
          </span>
        )}
        {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
      </div>

      {progress !== undefined && (
        <Progress value={progress} className="mt-2 h-1.5" indicatorClassName={progressClassName} />
      )}
    </Card>
  );
}
