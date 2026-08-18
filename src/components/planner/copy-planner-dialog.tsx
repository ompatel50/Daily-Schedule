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
import { formatDay, formatWeekRange, shiftDay } from "@/lib/date";
import { summarizeConflicts } from "@/lib/logic/planner";
import { copyPlannerDay, copyPlannerWeek, type CopyPlannerResult } from "@/server/actions/planner";
import type { ActionResult } from "@/lib/validation";

/**
 * "Copy this day/week to…": duplicates one-off blocks onto the chosen
 * day/week. Repeating blocks are deliberately not copied (they already
 * repeat), and the dialog says so up front. Overlaps warn with a confirm
 * toast — the planner's usual double-booking manners, never a hard stop.
 */
export function CopyPlannerDialog({
  mode,
  from,
  weekStartsOn,
  open,
  onOpenChange,
}: {
  mode: "day" | "week";
  /** The source: the day being viewed (any day of the week in week mode). */
  from: string;
  weekStartsOn: 0 | 1;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [to, setTo] = React.useState(() => shiftDay(from, mode === "week" ? 7 : 1));

  React.useEffect(() => {
    if (open) setTo(shiftDay(from, mode === "week" ? 7 : 1));
  }, [open, from, mode]);

  const action = mode === "day" ? copyPlannerDay : copyPlannerWeek;
  const sourceLabel =
    mode === "day" ? formatDay(from) : formatWeekRange(from, weekStartsOn);

  function describe(result: Extract<CopyPlannerResult, { status: "copied" }>): string {
    const copied =
      result.created === 0
        ? "Nothing to copy"
        : `Copied ${result.created} ${result.created === 1 ? "block" : "blocks"}`;
    return result.skippedRecurring > 0
      ? `${copied} — ${result.skippedRecurring} repeating ${
          result.skippedRecurring === 1 ? "block" : "blocks"
        } skipped (already repeating)`
      : copied;
  }

  const submit = (confirm: boolean) =>
    startTransition(async () => {
      const result: ActionResult<CopyPlannerResult> = await action({ from, to, confirm });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.status === "empty") {
        toast.info(mode === "day" ? "That day is empty" : "That week is empty");
        onOpenChange(false);
        return;
      }
      if (result.data.status === "conflict") {
        const summary = summarizeConflicts(result.data.conflicts);
        toast.warning(`Would overlap ${summary ?? "existing blocks"}.`, {
          description: "Nothing was copied yet.",
          action: { label: "Copy anyway", onClick: () => submit(true) },
          // The action needs reaching and reading — sonner's ~4 s default is
          // too short for a keyboard or screen-reader user (move-conflict.ts
          // sets the same window for the same pattern).
          duration: 10_000,
        });
        return;
      }
      toast.success(describe(result.data), {
        action: {
          label: mode === "day" ? "Open day" : "Open week",
          onClick: () =>
            router.push(`/planner?date=${to}${mode === "week" ? "&view=week" : ""}`),
        },
      });
      onOpenChange(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "day" ? "Copy day" : "Copy week"}</DialogTitle>
            <DialogDescription>
              Copies {sourceLabel}&apos;s one-off blocks{" "}
              {mode === "week" ? "onto the same weekdays of another week" : "onto another day"}.
              Repeating blocks aren&apos;t copied — they already repeat.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5 py-4">
            <Label htmlFor="copy-target">{mode === "day" ? "Copy to day" : "Copy to week of"}</Label>
            <Input
              id="copy-target"
              type="date"
              autoFocus
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            {mode === "week" && (
              <p className="text-xs text-muted-foreground">
                Any day inside the target week works — it copies to {formatWeekRange(to, weekStartsOn)}.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !to}>
              {pending && <Loader2 className="animate-spin" />}
              Copy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
