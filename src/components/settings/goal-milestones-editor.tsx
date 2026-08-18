"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, CheckCircle2, Circle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay } from "@/lib/date";
import { deleteGoalMilestone, saveGoalMilestone } from "@/server/actions/goals";
import type { GoalMilestoneRow } from "@/components/settings/goals-panel";

/**
 * Ordered checkpoints on the way to a goal's target. Reaching one is recorded
 * by the server the moment the measured value first meets it — this editor
 * only creates, edits reminders, and removes. Each milestone can opt into a
 * target-date reminder that rides the normal reminder feed.
 */
export function GoalMilestonesEditor({
  goalId,
  milestones,
  unit,
}: {
  goalId: string;
  milestones: GoalMilestoneRow[];
  unit: string;
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState(milestones);
  const [pending, startTransition] = React.useTransition();
  const [label, setLabel] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [date, setDate] = React.useState("");
  const [remind, setRemind] = React.useState(false);
  // Removal is a hard delete (milestones don't go to the Trash), so it gets
  // the app's two-step confirm; only one row confirms at a time.
  const [confirmingRemove, setConfirmingRemove] = React.useState<string | null>(null);

  React.useEffect(() => setRows(milestones), [milestones]);

  function add() {
    const targetValue = Number(target);
    if (!target.trim() || !Number.isFinite(targetValue)) {
      toast.error("Give the milestone a numeric target");
      return;
    }
    startTransition(async () => {
      const result = await saveGoalMilestone({
        goalId,
        label: label.trim() || null,
        targetValue,
        targetDate: date || null,
        reminderEnabled: remind && Boolean(date),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRows((current) => [
        ...current,
        {
          id: result.data.id,
          label: label.trim() || null,
          targetValue,
          targetDate: date || null,
          ordinal: current.length,
          reminderEnabled: remind && Boolean(date),
          reachedAt: null,
        },
      ]);
      setLabel("");
      setTarget("");
      setDate("");
      setRemind(false);
      router.refresh();
    });
  }

  /** Enter in the add row adds the milestone — implicit submission would save
   *  and close the whole goal dialog, losing what was just typed. */
  function addOnEnter(event: React.KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  }

  function toggleReminder(row: GoalMilestoneRow) {
    startTransition(async () => {
      const result = await saveGoalMilestone({
        id: row.id,
        goalId,
        label: row.label,
        targetValue: row.targetValue,
        targetDate: row.targetDate,
        reminderEnabled: !row.reminderEnabled,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRows((current) =>
        current.map((entry) =>
          entry.id === row.id ? { ...entry, reminderEnabled: !row.reminderEnabled } : entry,
        ),
      );
      router.refresh();
    });
  }

  function remove(row: GoalMilestoneRow) {
    setConfirmingRemove(null);
    startTransition(async () => {
      const result = await deleteGoalMilestone(row.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRows((current) => current.filter((entry) => entry.id !== row.id));
      toast.success(`Milestone ${row.label ?? row.targetValue} removed`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="section-title">Milestones</p>
      <p className="text-xs text-muted-foreground">
        Checkpoints on the way to the target. Reaching one is recorded automatically; a milestone
        with a date can remind you as it approaches.
      </p>

      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 text-sm"
            >
              {row.reachedAt ? (
                <CheckCircle2
                  role="img"
                  className="h-4 w-4 shrink-0 text-emerald-500"
                  aria-label={`Reached ${formatDay(row.reachedAt.slice(0, 10))}`}
                />
              ) : (
                <Circle
                  role="img"
                  className="h-4 w-4 shrink-0 text-muted-foreground/50"
                  aria-label="Not reached yet"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {row.label ?? `${row.targetValue}${unit ? ` ${unit}` : ""}`}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {row.targetValue}
                {unit ? ` ${unit}` : ""}
                {row.targetDate ? ` · by ${formatDay(row.targetDate, "MMM d")}` : ""}
              </span>
              {row.targetDate && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pending}
                  className="touch-target shrink-0"
                  aria-label={
                    row.reminderEnabled
                      ? `Turn off the reminder for ${row.label ?? row.targetValue}`
                      : `Remind me about ${row.label ?? row.targetValue}`
                  }
                  onClick={() => toggleReminder(row)}
                >
                  {row.reminderEnabled ? <Bell className="text-domain-habit" /> : <BellOff />}
                </Button>
              )}
              {confirmingRemove === row.id ? (
                <span role="status" className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => remove(row)}
                  >
                    Really remove?
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingRemove(null)}
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Delete milestone ${row.label ?? row.targetValue}`}
                  className="touch-target shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setConfirmingRemove(row.id)}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_6rem_8.5rem_auto]">
        <Input
          aria-label="Milestone label"
          placeholder="Label (optional)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={addOnEnter}
        />
        <Input
          aria-label="Milestone target value"
          placeholder={unit ? unit : "Value"}
          inputMode="decimal"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onKeyDown={addOnEnter}
        />
        <Input
          aria-label="Milestone target date"
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            if (!event.target.value) setRemind(false);
          }}
          onKeyDown={addOnEnter}
        />
        <Button type="button" variant="outline" disabled={pending} onClick={() => add()}>
          <Plus /> Add
        </Button>
      </div>
      {date && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="milestone-remind"
            checked={remind}
            onCheckedChange={(checked) => setRemind(checked === true)}
          />
          <Label htmlFor="milestone-remind" className="text-xs font-normal text-muted-foreground">
            Remind me as the date approaches
          </Label>
        </div>
      )}
    </div>
  );
}
