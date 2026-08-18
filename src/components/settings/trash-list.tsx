"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/date";
import { emptyTrash, purgeTrashItem, restoreTrashItem } from "@/server/actions/trash";
import type { TrashItem } from "@/server/trash";

/**
 * The Trash: everything soft-deleted, restorable per item until the daily
 * sweep purges it. Restore is link-aware server-side (a transfer restores
 * its pair, a task its subtasks); this list only names things honestly.
 */
export function TrashList({
  items,
  retentionDays,
}: {
  items: TrashItem[];
  retentionDays: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmingEmpty, setConfirmingEmpty] = React.useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) toast.success(message);
      else toast.error(result.error ?? "Something went wrong");
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        The trash is empty. Deleted items wait here for {retentionDays} days before they are
        removed for good.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Deleted items stay restorable for {retentionDays} days, then are removed for good.
        </p>
        {confirmingEmpty ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              setConfirmingEmpty(false);
              run(() => emptyTrash(), "Trash emptied");
            }}
          >
            Really delete everything?
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirmingEmpty(true)}>
            <Trash2 /> Empty trash
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={`${item.model}:${item.id}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
          >
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {item.module}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
            {item.detail && (
              <span className="text-xs text-muted-foreground">{item.detail}</span>
            )}
            <span
              className="text-xs text-muted-foreground"
              title={`Gone for good on ${formatDay(item.purgeAt.slice(0, 10))}`}
            >
              deleted {formatDay(item.deletedAt.slice(0, 10), "MMM d")}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Restore ${item.title}`}
                onClick={() =>
                  run(() => restoreTrashItem(item.model, item.id), `Restored “${item.title}”`)
                }
              >
                <ArchiveRestore /> Restore
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`Delete ${item.title} forever`}
                className="text-destructive hover:text-destructive"
                onClick={() =>
                  run(() => purgeTrashItem(item.model, item.id), "Deleted forever")
                }
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
