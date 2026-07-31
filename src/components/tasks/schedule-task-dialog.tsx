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
import { formatDay, parseTimeToMinute } from "@/lib/date";
import { scheduleTaskOnPlanner } from "@/server/actions/tasks";

export interface ScheduleSource {
  id: string;
  title: string;
  /** Prefills the date picker; today when the task has no due date. */
  dueDate: string | null;
}

/**
 * "Add to planner": creates an ordinary planner block for the task on a chosen
 * day — all-day unless a time is given. The block links back to the task but
 * behaves exactly like one typed into the planner.
 */
export function ScheduleTaskDialog({
  task,
  today,
  onClose,
}: {
  /** The task being scheduled; null closes the dialog. */
  task: ScheduleSource | null;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [date, setDate] = React.useState(today);
  const [time, setTime] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!task) return;
    // A due date in the past is not a useful planning default.
    setDate(task.dueDate && task.dueDate >= today ? task.dueDate : today);
    setTime("");
    setErrors({});
  }, [task, today]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!task) return;
    setErrors({});

    const startMinute = time ? parseTimeToMinute(time) : null;
    if (time && startMinute === null) {
      setErrors({ time: ["Enter a time like 14:30, or leave it empty"] });
      return;
    }

    startTransition(async () => {
      const result = await scheduleTaskOnPlanner({
        taskId: task.id,
        date,
        startMinute,
        endMinute: startMinute !== null ? Math.min(startMinute + 60, 1439) : null,
      });

      if (result.ok) {
        toast.success(`On the planner for ${formatDay(result.data.date)}`, {
          action: {
            label: "Open planner",
            onClick: () => router.push(`/planner?date=${result.data.date}`),
          },
        });
        onClose();
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add to planner</DialogTitle>
            <DialogDescription>
              Blocks a day for “{task?.title}”. The planner block and the task stay separate —
              completing one never completes the other.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-date">Day</Label>
              <Input
                id="schedule-date"
                type="date"
                autoFocus
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-time">Start time (optional)</Label>
              <Input
                id="schedule-time"
                type="time"
                value={time}
                aria-invalid={Boolean(errors.time)}
                aria-describedby={errors.time ? "schedule-time-error" : undefined}
                onChange={(event) => setTime(event.target.value)}
              />
              {errors.time ? (
                <p id="schedule-time-error" className="text-xs text-destructive">
                  {errors.time[0]}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Empty = an all-day block.</p>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                Add to planner
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
