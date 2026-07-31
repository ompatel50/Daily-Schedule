"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Undo2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import type { ImportBatchView } from "@/components/finance/finance-board";
import { formatDay } from "@/lib/date";
import { formatMoney } from "@/lib/logic/finance";
import { pluralize } from "@/lib/utils";
import {
  previewFinanceImportUndo,
  undoFinanceImport,
  type ImportUndoPreview,
} from "@/server/actions/finance-import";

/**
 * Undo a CSV import: always preview first, then confirm. The preview is the
 * server's own plan — the same classification the undo will run — so the
 * counts shown are the counts that happen, and the rows the undo will keep are
 * named before anything is deleted.
 */
export function UndoImportDialog({
  batch,
  onClose,
}: {
  batch: ImportBatchView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [preview, setPreview] = React.useState<ImportUndoPreview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const batchId = batch?.id ?? null;

  React.useEffect(() => {
    if (!batchId) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewFinanceImportUndo(batchId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setPreview(result.data);
        else setError(result.error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  function confirm() {
    if (!batchId) return;
    startTransition(async () => {
      const result = await undoFinanceImport(batchId);
      if (result.ok) {
        const { removedCount, keptEditedCount, keptLinkedCount } = result.data;
        const kept = keptEditedCount + keptLinkedCount;
        toast.success(
          `Removed ${removedCount} imported ${pluralize(removedCount, "transaction")}` +
            (kept > 0 ? ` · kept ${kept} you had changed` : ""),
        );
        onClose();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const kept = preview ? preview.keptEditedCount + preview.keptLinkedCount : 0;

  return (
    <Dialog open={batch !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Undo this import?</DialogTitle>
          <DialogDescription>
            {batch
              ? `${batch.fileName}${batch.accountName ? ` → ${batch.accountName}` : ""}, imported ${formatDay(batch.importedDay)}.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : preview ? (
            <>
              <p className="text-sm">
                <span className="font-medium">
                  {preview.removableCount} {pluralize(preview.removableCount, "transaction")}
                </span>{" "}
                will be permanently removed.
              </p>

              {kept > 0 && (
                <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">
                    {kept} {pluralize(kept, "row")} will be kept
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {preview.keptEditedCount > 0 && (
                      <li>
                        {preview.keptEditedCount} edited since the import (date, amount, payee or
                        account changed).
                      </li>
                    )}
                    {preview.keptLinkedCount > 0 && (
                      <li>
                        {preview.keptLinkedCount} now linked to a bill payment or a transfer.
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {preview.sample.length > 0 && (
                <div className="rounded-lg border">
                  <table className="w-full text-xs">
                    <tbody>
                      {preview.sample.map((row) => (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {formatDay(row.date, "MMM d")}
                          </td>
                          <td className="max-w-[16rem] truncate px-2 py-1.5">{row.payee ?? "—"}</td>
                          <td className="tabular px-2 py-1.5 text-right">
                            {formatMoney(row.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.removableCount > preview.sample.length && (
                    <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      and {preview.removableCount - preview.sample.length} more…
                    </p>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                The import stays in your history, marked as undone. Re-importing the same file
                afterwards recreates exactly the rows that were removed.
              </p>
            </>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || loading || !preview || preview.removableCount === 0}
            onClick={confirm}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Remove {preview?.removableCount ?? 0}{" "}
            {pluralize(preview?.removableCount ?? 0, "transaction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
