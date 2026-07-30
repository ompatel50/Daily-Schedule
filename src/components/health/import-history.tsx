"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { History, Loader2, Trash2 } from "lucide-react";
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
import { formatNumber } from "@/lib/utils";
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
  /** Pre-formatted on the server — formatting a Date here would hydrate
   * differently when the server and browser disagree on locale or zone. */
  importedAtLabel: string;
  categoriesList: string[];
  warningsList: string[];
}

function categoryLabel(key: string): string {
  if (key === "workouts") return "Workouts";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

/**
 * Past imports, each removable as a unit. Removal shows exactly what will be
 * deleted before asking for confirmation; manual entries and other batches are
 * untouched by construction.
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
      toast.success(
        `Removed ${formatNumber(result.data.removedMetrics)} records` +
          (result.data.removedWorkouts > 0
            ? ` and ${formatNumber(result.data.removedWorkouts)} workouts`
            : ""),
        { description: "Goals, scores, the calendar and insights have been recalculated." },
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
        No imports yet. Records you import appear here, and each import can be removed again as a
        unit without touching anything you entered by hand.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {batches.map((batch) => (
        <div key={batch.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{batch.fileName}</span>
                <Badge
                  variant={batch.status === "failed" ? "danger" : "muted"}
                  className="text-[10px] capitalize"
                >
                  {batch.status}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {batch.importedAtLabel} ·{" "}
                {batch.source === "apple_health" ? "Apple Health" : "CSV"}
                {batch.dateFrom && batch.dateTo ? ` · ${batch.dateFrom} → ${batch.dateTo}` : ""}
              </p>
              {batch.status === "failed" && batch.error ? (
                <p className="mt-1 text-xs text-destructive">{batch.error}</p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(batch.imported)} new · {formatNumber(batch.updated)} refreshed ·{" "}
                  {formatNumber(batch.duplicates)} already present
                  {batch.workoutsImported > 0
                    ? ` · ${formatNumber(batch.workoutsImported)} workouts`
                    : ""}
                  {batch.invalid > 0 ? ` · ${formatNumber(batch.invalid)} invalid` : ""}
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
            </div>
            {batch.status === "completed" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => askRemove(batch.id)}
                disabled={busy !== null}
                aria-label={`Remove the import ${batch.fileName}`}
              >
                {busy === batch.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Remove
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
                <DialogTitle>Remove this import?</DialogTitle>
                <DialogDescription>
                  This deletes only the records that came from {removal.fileName}. Manual entries
                  and other imports stay, and every affected day is recalculated.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="tabular font-semibold">{formatNumber(removal.metricCount)}</span>{" "}
                  health records
                  {removal.workoutCount > 0 && (
                    <>
                      {" and "}
                      <span className="tabular font-semibold">
                        {formatNumber(removal.workoutCount)}
                      </span>{" "}
                      imported workouts
                    </>
                  )}{" "}
                  will be deleted
                  {removal.dateFrom && removal.dateTo
                    ? ` (${removal.dateFrom} → ${removal.dateTo})`
                    : ""}
                  .
                </p>
                {removal.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {removal.categories.map((category) => (
                      <Badge key={category.type} variant="muted" className="text-[10px]">
                        {categoryLabel(category.type)} × {formatNumber(category.count)}
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
                  Remove import
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
