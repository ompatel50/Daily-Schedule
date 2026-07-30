import { toast } from "sonner";

import { summarizeConflicts } from "@/lib/logic/planner";

/**
 * `moveScheduleItem` landed on an occupied slot and wrote nothing. Nonblocking
 * by design: the toast names the clash and "Move anyway" repeats the move with
 * `confirm: true`. Ignoring it simply leaves the item where it was.
 */
export function confirmMoveToast(conflicts: string[], onConfirm: () => void) {
  toast.warning(`Overlaps ${summarizeConflicts(conflicts) ?? "another block"}`, {
    description: "Nothing was moved. Double-booking is allowed — move anyway?",
    duration: 10_000,
    action: { label: "Move anyway", onClick: onConfirm },
  });
}
