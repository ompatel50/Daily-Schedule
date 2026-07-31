"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { History, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { formatBytes, formatNumber } from "@/lib/utils";
import {
  previewBatchRemovalAction,
  removeImportBatchAction,
} from "@/server/actions/health-import";
import type { BatchRemovalPreview } from "@/server/health-import";

export interface BatchSummary {
  id: string;
  fileName: string;
  source: string;
  fileType: string;
  fileSize: number | null;
  status: string;
  error: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  imported: number;
  updated: number;
  duplicates: number;
  skipped: number;
  invalid: number;
  workoutsImported: number;
  workoutsSkipped: number;
  recordsImported: number;
  durationMs: number | null;
  xmlBytes: number | null;
  undoneCount: number;
  keptCount: number;
  /** Pre-formatted on the server — formatting a Date here would hydrate
   * differently when the server and browser disagree on locale or zone. */
  importedAtLabel: string;
  undoneAtLabel: string | null;
  categoriesList: string[];
  warningsList: string[];
  errorsList: string[];
  ignoredFilesList: string[];
}

function categoryLabel(key: string): string {
  if (key === "workouts") return "Workouts";
  if (key === "records") return "Health records";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

/**
 * Past imports, each undoable as a unit.
 *
 * The undo shows exactly what it would delete *and what it would keep* before
 * asking — a row you have edited since importing, or a workout you have since
 * added sets to, is listed as kept rather than quietly removed.
 */
export function ImportHistory({ batches }: { batches: BatchSummary[] }) {
  const router = useRouter();
  const [removal, setRemoval] = React.useState<BatchRemovalPreview | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function askRemove(batchId: string) {
    setBusy(batchId);
    try {
      const result = await previewBatchRemovalAction(batchId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRemoval(result.data);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removal) return;
    setBusy(removal.batchId);
    try {
      const result = await removeImportBatchAction(removal.batchId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { removedMetrics, removedWorkouts, removedRecords, keptCount } = result.data;
      toast.success(
        `Undone — removed ${formatNumber(removedMetrics)} readings` +
          (removedWorkouts > 0 ? `, ${formatNumber(removedWorkouts)} workouts` : "") +
          (removedRecords > 0 ? `, ${formatNumber(removedRecords)} records` : ""),
        {
          description:
            (keptCount > 0
              ? `${formatNumber(keptCount)} kept because you changed or built on them. `
              : "") + "Goals, scores, the calendar and insights have been recalculated.",
        },
      );
      setRemoval(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (batches.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No imports yet. Records you import appear here, and each import can be undone as a unit
        without touching anything you entered by hand.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {batches.map((batch) => (
        <div key={batch.id} className="rounded-lg border p-3" data-testid="import-batch">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{batch.fileName}</span>
                <Badge
                  variant={
                    batch.status === "failed"
                      ? "danger"
                      : batch.status === "removed"
                        ? "outline"
                        : "muted"
                  }
                  className="text-[10px] capitalize"
                >
                  {batch.status === "removed" ? "undone" : batch.status}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {batch.importedAtLabel} · {batch.source === "apple_health" ? "Apple Health" : "CSV"}
                {batch.fileSize ? ` · ${formatBytes(batch.fileSize)}` : ""}
                {batch.durationMs !== null ? ` · wrote in ${(batch.durationMs / 1000).toFixed(1)}s` : ""}
                {batch.dateFrom && batch.dateTo ? ` · ${batch.dateFrom} → ${batch.dateTo}` : ""}
              </p>
              {batch.status === "failed" && batch.error ? (
                <p className="mt-1 text-xs text-destructive">{batch.error}</p>
              ) : batch.status === "removed" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Undone{batch.undoneAtLabel ? ` ${batch.undoneAtLabel}` : ""} ·{" "}
                  {formatNumber(batch.undoneCount)} removed
                  {batch.keptCount > 0 ? ` · ${formatNumber(batch.keptCount)} kept` : ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(batch.imported)} new · {formatNumber(batch.updated)} refreshed ·{" "}
                  {formatNumber(batch.duplicates)} already present
                  {batch.workoutsImported > 0
                    ? ` · ${formatNumber(batch.workoutsImported)} workouts`
                    : ""}
                  {batch.recordsImported > 0
                    ? ` · ${formatNumber(batch.recordsImported)} records`
                    : ""}
                  {batch.invalid > 0 ? ` · ${formatNumber(batch.invalid)} invalid` : ""}
                  {batch.skipped > 0 ? ` · ${formatNumber(batch.skipped)} unsupported` : ""}
                </p>
              )}
              {batch.categoriesList.length > 0 && batch.status !== "failed" && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {batch.categoriesList.map((key) => (
                    <Badge key={key} variant="muted" className="text-[10px]">
                      {categoryLabel(key)}
                    </Badge>
                  ))}
                </div>
              )}
              {(batch.warningsList.length > 0 || batch.errorsList.length > 0) && (
                <details className="mt-1.5 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {batch.warningsList.length + batch.errorsList.length} note
                    {batch.warningsList.length + batch.errorsList.length === 1 ? "" : "s"} from this
                    import
                  </summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {[...batch.errorsList, ...batch.warningsList].slice(0, 10).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            {batch.status === "completed" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => askRemove(batch.id)}
                disabled={busy !== null}
                aria-label={`Undo the import ${batch.fileName}`}
              >
                {busy === batch.id ? <Loader2 className="animate-spin" /> : <Undo2 />}
                Undo
              </Button>
            )}
          </div>
        </div>
      ))}

      <Dialog open={removal !== null} onOpenChange={(open) => !open && setRemoval(null)}>
        <DialogContent className="max-w-md">
          {removal && (
            <>
              <DialogHeader>
                <DialogTitle>Undo this import?</DialogTitle>
                <DialogDescription>
                  This removes only what {removal.fileName} wrote and still owns. Manual entries,
                  other imports, and anything you have changed since stay exactly as they are.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="tabular font-semibold">{formatNumber(removal.metricCount)}</span>{" "}
                  readings
                  {removal.workoutCount > 0 && (
                    <>
                      {", "}
                      <span className="tabular font-semibold">
                        {formatNumber(removal.workoutCount)}
                      </span>{" "}
                      workouts
                    </>
                  )}
                  {removal.recordCount > 0 && (
                    <>
                      {", "}
                      <span className="tabular font-semibold">
                        {formatNumber(removal.recordCount)}
                      </span>{" "}
                      health records
                    </>
                  )}{" "}
                  will be deleted
                  {removal.dateFrom && removal.dateTo
                    ? ` (${removal.dateFrom} → ${removal.dateTo})`
                    : ""}
                  .
                </p>
                {removal.keptEdited + removal.keptLinked > 0 && (
                  <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    <span className="tabular font-semibold text-foreground">
                      {formatNumber(removal.keptEdited + removal.keptLinked)}
                    </span>{" "}
                    will be kept
                    {removal.keptEdited > 0 && ` — ${formatNumber(removal.keptEdited)} you edited`}
                    {removal.keptLinked > 0 &&
                      `${removal.keptEdited > 0 ? "," : " —"} ${formatNumber(removal.keptLinked)} now used by something else`}
                    .
                  </p>
                )}
                {removal.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {removal.categories.map((category) => (
                      <Badge key={category.type} variant="muted" className="text-[10px]">
                        {category.label} × {formatNumber(category.count)}
                      </Badge>
                    ))}
                    {removal.recordKinds.map((kind) => (
                      <Badge key={kind.kind} variant="muted" className="text-[10px]">
                        {kind.label} × {formatNumber(kind.count)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRemoval(null)} disabled={busy !== null}>
                  Keep it
                </Button>
                <Button variant="destructive" onClick={confirmRemove} disabled={busy !== null}>
                  {busy !== null && <Loader2 className="animate-spin" />}
                  Undo import
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
