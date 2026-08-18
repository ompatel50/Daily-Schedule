"use client";

import { toast } from "sonner";

import type { SoftDeleteModel } from "@/lib/soft-delete";
import { restoreTrashItem } from "@/server/actions/trash";

/**
 * The success toast for anything that soft-deletes: since Trash arrived,
 * "deleted" is reversible for 30 days, so the toast says where the record
 * went and carries the one-click way back. Undo is the REAL restore — the
 * same action the Settings → Trash page runs — not a visual rollback.
 *
 * Deliberately not used by the planner's series deletes: restoring a series
 * or a skipped occurrence has follow-on questions (skip dates, materialized
 * children) that the Trash page presents properly; those toasts name the
 * Trash without offering a one-click undo.
 */
export function toastMovedToTrash(
  message: string,
  model: SoftDeleteModel,
  id: string,
  refresh: () => void,
): void {
  toast.success(message, {
    action: {
      label: "Undo",
      onClick: () => {
        void restoreTrashItem(model, id).then((result) => {
          if (result.ok) {
            toast.success("Restored");
            refresh();
          } else {
            toast.error(result.error ?? "Could not restore — see Settings → Trash");
          }
        });
      },
    },
  });
}
