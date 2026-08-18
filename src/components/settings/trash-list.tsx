"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDay } from "@/lib/date";
import { emptyTrash, purgeTrashItem, restoreTrashItem } from "@/server/actions/trash";
import type { TrashItem } from "@/server/trash";

/**
 * The Trash: everything soft-deleted, restorable per item until the daily
 * sweep purges it. Restore is link-aware server-side (a transfer restores
 * its pair, a task its subtasks); this list only names things honestly.
 * Purging is the one truly irreversible act on this page, so both purge
 * buttons (per item and empty-all) are two-step with a way back.
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
  const [confirmingPurge, setConfirmingPurge] = React.useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) toast.success(message);
      else toast.error(result.error ?? "Something went wrong");
      router.refresh();
    });
  }

  function runEmpty() {
    setConfirmingEmpty(false);
    startTransition(async () => {
      const result = await emptyTrash();
      if (result.ok) {
        const { purged } = result.data;
        toast.success(
          purged === 1 ? "Trash emptied — 1 item removed" : `Trash emptied — ${purged} items removed`,
        );
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Trash2}
        title="The trash is empty"
        description={`Deleted items wait here for ${retentionDays} days before they are removed for good.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-[12rem] max-w-lg flex-1 text-sm text-muted-foreground">
          Deleted items stay restorable for {retentionDays} days, then are removed for good.
        </p>
        {confirmingEmpty ? (
          <span role="status" className="flex items-center gap-1">
            <Button variant="destructive" size="sm" disabled={pending} onClick={runEmpty}>
              Really delete everything?
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingEmpty(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirmingEmpty(true)}>
            <Trash2 /> Empty trash
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const key = `${item.model}:${item.id}`;
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
            >
              <Badge variant="outline" className="text-[10px]">
                {item.module}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
              {item.detail && (
                <span className="text-xs text-muted-foreground">{item.detail}</span>
              )}
              {/* The purge deadline is the one fact a Trash row must state —
                  visible text, not a hover-only title. */}
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                deleted {formatDay(item.deletedAt.slice(0, 10), "MMM d")} · gone{" "}
                {formatDay(item.purgeAt.slice(0, 10), "MMM d")}
              </span>
              <div className="flex items-center gap-1">
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
                {confirmingPurge === key ? (
                  <span role="status" className="flex items-center gap-1">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setConfirmingPurge(null);
                        run(() => purgeTrashItem(item.model, item.id), "Deleted forever");
                      }}
                    >
                      Really?
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmingPurge(null)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending}
                    aria-label={`Delete ${item.title} forever`}
                    className="touch-target text-destructive hover:text-destructive"
                    onClick={() => setConfirmingPurge(key)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
