"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Target, Trash2 } from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/shared/section-card";
import {
  describeTargetRemaining,
  GOAL_DAY_TYPE_META,
  GOAL_DAY_TYPES,
  NUTRITION_TARGET_METRICS,
  type GoalDayType,
} from "@/lib/logic/goals";
import { formatNumber, pct } from "@/lib/utils";
import { deleteGoalPermanently, saveGoalWithSchedule } from "@/server/actions/goals";
import type { NutritionTargetsView } from "@/server/queries";

/**
 * Daily nutrition targets — the numbers logging is measured against.
 *
 * Deliberately a self-tracking surface, not a coach: targets are entirely
 * user-chosen (nothing is suggested or derived from body data), progress is
 * stated as plain numbers — consumed, remaining, over — with no alarm
 * styling, no streaks, and an unlogged day reads "not logged yet", never
 * zero. Targets can differ between training and rest days; the card names
 * which set applies.
 */
export function TargetsCard({ view }: { view: NutritionTargetsView }) {
  const activeRows = view.rows.filter((row) => row.applies);
  const inactiveRows = view.rows.filter((row) => !row.applies);

  return (
    <SectionCard
      title="Targets"
      icon={Target}
      accent="text-domain-nutrition"
      description={
        view.hasVariants
          ? `${view.dayType === "training" ? "Training-day" : "Rest-day"} targets apply today`
          : "Your daily numbers — set by you"
      }
      action={<TargetsDialog view={view} />}
    >
      {activeRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No targets yet. Set the numbers you want to log against — they&apos;re yours to
          choose, and the app never computes them for you.
        </p>
      ) : (
        <div className="space-y-3">
          {activeRows.map((row) => (
            <TargetRow key={row.id} row={row} />
          ))}
        </div>
      )}
      {inactiveRows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {inactiveRows.length === 1 ? "One target waits" : `${inactiveRows.length} targets wait`}{" "}
          for {view.dayType === "training" ? "a rest day" : "a training day"}.
        </p>
      )}
    </SectionCard>
  );
}

type TargetRowView = NutritionTargetsView["rows"][number];

function TargetRow({ row }: { row: TargetRowView }) {
  const consumedLabel =
    row.consumed === null ? "—" : `${formatNumber(row.consumed, row.unit === "kcal" ? 0 : 1)}`;
  const targetLabel =
    row.direction === "range" && row.targetMax !== null
      ? `${formatNumber(row.target)}–${formatNumber(row.targetMax)} ${row.unit}`
      : `${formatNumber(row.target)} ${row.unit}`;
  const progressCeiling = row.direction === "range" ? (row.targetMax ?? row.target) : row.target;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {row.label}
          {row.dayType !== "all" && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              ({GOAL_DAY_TYPE_META[row.dayType as GoalDayType]?.label.toLowerCase()})
            </span>
          )}
        </span>
        <span className="text-muted-foreground">
          {consumedLabel} of {targetLabel}
        </span>
      </div>
      <Progress
        value={row.consumed === null ? 0 : pct(row.consumed, progressCeiling)}
        className="mt-1 h-1.5"
      />
      <p className="mt-0.5 text-xs text-muted-foreground">
        {describeTargetRemaining(row, row.consumed)}
      </p>
    </div>
  );
}

const DIRECTION_OPTIONS = [
  { value: "gte", label: "At least" },
  { value: "lte", label: "At most" },
  { value: "range", label: "Between" },
] as const;

function TargetsDialog({ view }: { view: NutritionTargetsView }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const [metric, setMetric] = React.useState(NUTRITION_TARGET_METRICS[0].metric);
  const [direction, setDirection] = React.useState<string>("gte");
  const [target, setTarget] = React.useState<string>("");
  const [targetMax, setTargetMax] = React.useState<string>("");
  const [dayType, setDayType] = React.useState<GoalDayType>("all");

  const chosen = NUTRITION_TARGET_METRICS.find((entry) => entry.metric === metric);

  const duplicate = view.rows.some(
    (row) => row.metric === metric && row.dayType === dayType,
  );

  function add() {
    if (!chosen || pending) return;
    const value = Number(target);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the target number first");
      return;
    }
    const max = direction === "range" ? Number(targetMax) : null;
    if (direction === "range" && (!Number.isFinite(max) || (max as number) <= value)) {
      toast.error("The upper end of the range must be above the lower");
      return;
    }
    if (duplicate) {
      toast.error(
        `A ${chosen.label.toLowerCase()} target for ${GOAL_DAY_TYPE_META[dayType].label.toLowerCase()} already exists — remove it first`,
      );
      return;
    }

    startTransition(async () => {
      const suffix = dayType === "all" ? "" : ` (${GOAL_DAY_TYPE_META[dayType].label.toLowerCase()})`;
      const result = await saveGoalWithSchedule({
        goal: {
          domain: "nutrition",
          metric: chosen.metric,
          label: `${chosen.label}${suffix}`,
          target: value,
          targetMax: max,
          unit: chosen.unit,
          direction,
          period: "daily",
          source: chosen.source,
          dayType,
          active: true,
        },
        schedule: {
          mode: "every_day",
          weekdays: [],
          interval: 1,
          timesPerWeek: null,
          monthDay: null,
          enabled: true,
          daypart: "anytime",
          timeMinute: null,
          reminderEnabled: false,
          reminderMinute: null,
        },
      });
      if (result.ok) {
        toast.success(`${chosen.label} target set`);
        setTarget("");
        setTargetMax("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove(row: TargetRowView) {
    if (pending) return;
    startTransition(async () => {
      const result = await deleteGoalPermanently(row.id);
      if (result.ok) {
        toast.success(`${row.label} target moved to the Trash`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Edit targets
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nutrition targets</DialogTitle>
            <DialogDescription>
              Targets are yours to set — nothing here is suggested or computed from your
              body. The app only reports what you logged against the number you chose.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {view.rows.length > 0 && (
              <div className="space-y-2">
                {view.rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span>
                      {row.label} ·{" "}
                      {DIRECTION_OPTIONS.find((option) => option.value === row.direction)
                        ?.label ?? row.direction}{" "}
                      {row.direction === "range" && row.targetMax !== null
                        ? `${formatNumber(row.target)}–${formatNumber(row.targetMax)}`
                        : formatNumber(row.target)}{" "}
                      {row.unit}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="touch-target"
                      aria-label={`Remove ${row.label} target`}
                      disabled={pending}
                      onClick={() => remove(row)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <p className="text-xs font-medium text-muted-foreground">Add a target</p>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <Label htmlFor="target-metric" className="text-xs">
                    What
                  </Label>
                  <Select value={metric} onValueChange={setMetric}>
                    <SelectTrigger id="target-metric">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NUTRITION_TARGET_METRICS.map((entry) => (
                        <SelectItem key={entry.metric} value={entry.metric}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="target-direction" className="text-xs">
                    Kind
                  </Label>
                  <Select value={direction} onValueChange={setDirection}>
                    <SelectTrigger id="target-direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIRECTION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="target-value" className="text-xs">
                    {direction === "range" ? `From (${chosen?.unit})` : `Target (${chosen?.unit})`}
                  </Label>
                  <Input
                    id="target-value"
                    type="number"
                    min="1"
                    inputMode="decimal"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                </div>
                {direction === "range" ? (
                  <div className="space-y-1">
                    <Label htmlFor="target-max" className="text-xs">
                      To ({chosen?.unit})
                    </Label>
                    <Input
                      id="target-max"
                      type="number"
                      min="1"
                      inputMode="decimal"
                      value={targetMax}
                      onChange={(event) => setTargetMax(event.target.value)}
                    />
                  </div>
                ) : (
                  <div />
                )}
                <div className="space-y-1">
                  <Label htmlFor="target-daytype" className="text-xs">
                    Applies on
                  </Label>
                  <Select
                    value={dayType}
                    onValueChange={(value) => setDayType(value as GoalDayType)}
                  >
                    <SelectTrigger id="target-daytype">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GOAL_DAY_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {GOAL_DAY_TYPE_META[type].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={add} disabled={pending} className="gap-1.5">
                {pending ? <Loader2 className="animate-spin" /> : <Plus />}
                Add target
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
